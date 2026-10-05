import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  brainMessage,
  CloseCode,
  decodeBodyMessage,
  encode,
  type BodyToBrainMessage,
  type BrainToBodyMessage,
  type ErrorCode,
} from "@ms-minutes/protocol";
import type { Config } from "../../config.js";
import type { BodyRegistry } from "../bodies/registry.js";
import type { EventBus } from "../events/event-bus.js";

export type GatewayDeps = {
  config: Config;
  registry: BodyRegistry;
  bus: EventBus;
  /** Live connections by bodyId, shared across all connections. */
  connections: Map<string, BodyConnection>;
  log: FastifyBaseLogger;
  /** The brain has a voice, so bodies that can play audio get it instead of using their own. */
  speaks?: boolean;
};

type Hello = Extract<BodyToBrainMessage, { type: "hello" }>;

/** Placeholder bodyId used on error replies sent before a body has identified itself. */
const UNKNOWN_BODY = "unknown";

/**
 * One WebSocket connection from one body.
 * Lifecycle: connect → hello → welcome → messages/heartbeats → close.
 */
export class BodyConnection {
  readonly #socket: WebSocket;
  readonly #deps: GatewayDeps;
  readonly #sessionId = randomUUID();
  #bodyId: string | null = null;
  #helloTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(socket: WebSocket, deps: GatewayDeps) {
    this.#socket = socket;
    this.#deps = deps;
  }

  start(): void {
    this.#helloTimer = setTimeout(
      () => this.#fail("hello_required", "no hello received in time", CloseCode.HelloTimeout),
      this.#deps.config.helloTimeoutMs,
    );
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.on("close", (code) => this.#onClose(code));
    this.#socket.on("error", (err) =>
      this.#deps.log.warn({ err, bodyId: this.#bodyId }, "socket error"),
    );
  }

  /** Called when another connection claims the same bodyId. */
  replace(): void {
    this.#fail("replaced", "a newer connection for this body took over", CloseCode.Replaced);
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#sendError("invalid_message", "binary frames are not supported yet", false);
      return;
    }

    const result = decodeBodyMessage(rawToString(data));
    if (!result.ok) {
      const code: ErrorCode =
        result.code === "unsupported_version" ? "unsupported_version" : "invalid_message";
      if (this.#bodyId === null) {
        this.#fail(code, result.error, CloseCode.ProtocolError, result.id);
      } else {
        this.#sendError(code, result.error, false, result.id);
      }
      return;
    }

    const message = result.message;
    if (this.#bodyId === null) {
      if (message.type !== "hello") {
        this.#fail(
          "hello_required",
          "first message must be hello",
          CloseCode.ProtocolError,
          message.id,
        );
        return;
      }
      this.#onHello(message);
      return;
    }

    if (message.bodyId !== this.#bodyId) {
      this.#sendError(
        "body_id_mismatch",
        `this connection belongs to ${this.#bodyId}`,
        false,
        message.id,
      );
      return;
    }
    if (message.type === "hello") {
      this.#sendError(
        "duplicate_hello",
        "hello already received on this connection",
        false,
        message.id,
      );
      return;
    }

    this.#deps.registry.touch(this.#bodyId);
    this.#armHeartbeat();
    if (message.type === "heartbeat") return;

    this.#deps.bus.emit({ type: "body.message", bodyId: this.#bodyId, message });
  }

  #onHello(hello: Hello): void {
    clearTimeout(this.#helloTimer);
    const { registry, connections, bus, config, log } = this.#deps;

    connections.get(hello.bodyId)?.replace();

    this.#bodyId = hello.bodyId;
    connections.set(hello.bodyId, this);

    const now = new Date();
    const body = {
      id: hello.bodyId,
      type: hello.payload.bodyType,
      firmware: hello.payload.firmware,
      capabilities: hello.payload.capabilities,
      sessionId: this.#sessionId,
      connectedAt: now,
      lastSeenAt: now,
    };
    registry.add(body);

    this.send(
      brainMessage(
        "welcome",
        hello.bodyId,
        {
          sessionId: this.#sessionId,
          persona: { name: config.personaName },
          // Phase 0: every declared capability is permitted. The policy gate replaces this (ADR-0006).
          permissions: hello.payload.capabilities.map((c) => c.name),
          heartbeatIntervalMs: config.heartbeatIntervalMs,
          audio:
            (this.#deps.speaks ?? false) &&
            hello.payload.capabilities.some((c) => c.name === "speak.audio"),
        },
        hello.id,
      ),
    );
    this.#armHeartbeat();

    log.info(
      { bodyId: body.id, bodyType: body.type, capabilities: body.capabilities.map((c) => c.name) },
      "body connected",
    );
    bus.emit({ type: "body.connected", body });
  }

  #onClose(code: number): void {
    clearTimeout(this.#helloTimer);
    clearTimeout(this.#heartbeatTimer);

    const bodyId = this.#bodyId;
    const { connections, registry, bus, log } = this.#deps;
    // A replaced connection must not unregister its successor.
    if (bodyId === null || connections.get(bodyId) !== this) return;

    connections.delete(bodyId);
    registry.remove(bodyId);
    log.info({ bodyId, code }, "body disconnected");
    bus.emit({ type: "body.disconnected", bodyId, reason: `close ${code}` });
  }

  #armHeartbeat(): void {
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(
      () =>
        this.#fail(
          "heartbeat_timeout",
          "no heartbeat received in time",
          CloseCode.HeartbeatTimeout,
        ),
      this.#deps.config.heartbeatTimeoutMs,
    );
  }

  #fail(code: ErrorCode, message: string, closeCode: CloseCode, replyTo?: string): void {
    this.#sendError(code, message, true, replyTo);
    this.#socket.close(closeCode, code);
  }

  #sendError(code: ErrorCode, message: string, fatal: boolean, replyTo?: string): void {
    this.send(
      brainMessage("error", this.#bodyId ?? UNKNOWN_BODY, { code, message, fatal }, replyTo),
    );
  }

  /** Sends a message if the socket is still open. Returns whether it was sent. */
  send(message: BrainToBodyMessage): boolean {
    if (this.#socket.readyState !== this.#socket.OPEN) return false;
    this.#socket.send(encode(message));
    return true;
  }
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

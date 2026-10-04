import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  bodyMessage,
  CloseCode,
  decodeBrainMessage,
  encode,
  type BodyToBrainMessage,
  type BrainToBodyMessage,
} from "@ms-minutes/protocol";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeLLM } from "./fake-llm.js";

type Server = Awaited<ReturnType<typeof buildServer>>;

let server: Server | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.app.close();
  server = undefined;
});

// Tests never call the real Claude API.
async function start(env: Record<string, string> = {}, llm = new FakeLLM([])) {
  server = await buildServer(loadConfig({ PORT: "0", LOG_LEVEL: "silent", ...env }), { llm });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  return { ...server, url: `ws://127.0.0.1:${port}/ws` };
}

/** A minimal test body that queues incoming brain messages. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue: BrainToBodyMessage[] = [];
  const waiters: ((m: BrainToBodyMessage) => void)[] = [];
  ws.on("message", (raw) => {
    const result = decodeBrainMessage(raw.toString());
    if (!result.ok) throw new Error(`brain sent an invalid message: ${result.error}`);
    const waiter = waiters.shift();
    if (waiter) waiter(result.message);
    else queue.push(result.message);
  });
  const closed = once(ws, "close").then(([code]) => code as number);
  await once(ws, "open");
  return {
    ws,
    closed,
    send: (m: BodyToBrainMessage | object) => ws.send(JSON.stringify(m)),
    next: () =>
      new Promise<BrainToBodyMessage>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      }),
  };
}

const hello = (bodyId = "desk-01") =>
  bodyMessage("hello", bodyId, {
    bodyType: "desk_companion",
    firmware: "0.1.0",
    capabilities: [
      { name: "speak", riskTier: 0 },
      { name: "express", riskTier: 0 },
    ],
  });

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("body gateway", () => {
  it("answers hello with welcome and registers the body", async () => {
    const { url, app } = await start({ PERSONA_NAME: "Ms. Minutes" });
    const body = await connect(url);
    const msg = hello();
    body.send(msg);

    const welcome = await body.next();
    expect(welcome).toMatchObject({
      type: "welcome",
      bodyId: "desk-01",
      replyTo: msg.id,
      payload: { persona: { name: "Ms. Minutes" }, permissions: ["speak", "express"] },
    });

    const res = await app.inject({ method: "GET", url: "/api/bodies" });
    expect(res.json().bodies).toEqual([
      expect.objectContaining({ id: "desk-01", type: "desk_companion" }),
    ]);
  });

  it("rejects a first message that is not hello", async () => {
    const { url } = await start();
    const body = await connect(url);
    body.send(bodyMessage("heartbeat", "desk-01", {}));

    expect(await body.next()).toMatchObject({
      type: "error",
      payload: { code: "hello_required", fatal: true },
    });
    expect(await body.closed).toBe(CloseCode.ProtocolError);
  });

  it("rejects invalid JSON before hello", async () => {
    const { url } = await start();
    const body = await connect(url);
    body.ws.send("not json");

    expect(await body.next()).toMatchObject({ payload: { code: "invalid_message", fatal: true } });
    expect(await body.closed).toBe(CloseCode.ProtocolError);
  });

  it("reports unsupported protocol versions", async () => {
    const { url } = await start();
    const body = await connect(url);
    body.send({ ...hello(), v: 99 });

    expect(await body.next()).toMatchObject({ payload: { code: "unsupported_version" } });
    expect(await body.closed).toBe(CloseCode.ProtocolError);
  });

  it("keeps the connection open on recoverable errors after hello", async () => {
    const { url } = await start();
    const body = await connect(url);
    body.send(hello());
    await body.next();

    body.send(bodyMessage("heartbeat", "someone-else", {}));
    expect(await body.next()).toMatchObject({
      payload: { code: "body_id_mismatch", fatal: false },
    });
    body.send(hello());
    expect(await body.next()).toMatchObject({ payload: { code: "duplicate_hello", fatal: false } });
    expect(body.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("replaces an older connection that uses the same bodyId", async () => {
    const { url, registry } = await start();
    const first = await connect(url);
    first.send(hello());
    await first.next();

    const second = await connect(url);
    second.send(hello());

    expect(await first.next()).toMatchObject({ payload: { code: "replaced" } });
    expect(await first.closed).toBe(CloseCode.Replaced);
    const welcome = await second.next();
    expect(welcome.type).toBe("welcome");

    // The old socket closing must not unregister the new one.
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.get("desk-01")?.sessionId).toBe(
      welcome.type === "welcome" ? welcome.payload.sessionId : undefined,
    );
  });

  it("unregisters a body when it disconnects", async () => {
    const { url, registry, bus } = await start();
    const events: string[] = [];
    bus.on("body.disconnected", (e) => events.push(e.bodyId));

    const body = await connect(url);
    body.send(hello());
    await body.next();
    expect(registry.list()).toHaveLength(1);

    body.ws.close();
    await until(() => registry.list().length === 0);
    expect(events).toEqual(["desk-01"]);
  });

  it("forwards body events onto the event bus", async () => {
    const { url, bus } = await start();
    const received: BodyToBrainMessage[] = [];
    bus.on("body.message", (e) => received.push(e.message));

    const body = await connect(url);
    body.send(hello());
    await body.next();
    body.ws.send(encode(bodyMessage("event.utterance.text", "desk-01", { text: "Good morning" })));

    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ payload: { text: "Good morning" } });
  });

  it("answers an utterance with a streamed reply and an expression", async () => {
    const llm = new FakeLLM([
      { tools: [{ name: "set_expression", input: { affect: "happy", intensity: 0.5 } }] },
      { text: ["Good morning, ", "Thrishank."] },
    ]);
    const { url, app } = await start({}, llm);
    const body = await connect(url);
    body.send(hello());
    await body.next();

    body.send(bodyMessage("event.utterance.text", "desk-01", { text: "Good morning" }));
    const got: string[] = [];
    for (;;) {
      const m = await body.next();
      if (m.type === "state.set") got.push(m.payload.mode);
      if (m.type === "expression.set") got.push(m.payload.affect);
      if (m.type === "speech.text.delta") got.push(m.payload.text);
      if (m.type === "state.set" && m.payload.mode === "idle") break;
    }
    expect(got).toEqual(["thinking", "happy", "speaking", "Good morning, ", "Thrishank.", "idle"]);

    const res = await app.inject({ method: "GET", url: "/api/turns" });
    expect(res.json().turns[0]).toMatchObject({ bodyId: "desk-01", llmCalls: 2 });
  });

  it("disconnects a body that never says hello", async () => {
    const { url } = await start({ HELLO_TIMEOUT_MS: "50" });
    const body = await connect(url);
    expect(await body.next()).toMatchObject({ payload: { code: "hello_required" } });
    expect(await body.closed).toBe(CloseCode.HelloTimeout);
  });

  it("disconnects a body that stops sending heartbeats", async () => {
    const { url, registry } = await start({ HEARTBEAT_INTERVAL_MS: "20" });
    const body = await connect(url);
    body.send(hello());
    await body.next();

    expect(await body.next()).toMatchObject({ payload: { code: "heartbeat_timeout" } });
    expect(await body.closed).toBe(CloseCode.HeartbeatTimeout);
    await until(() => registry.list().length === 0);
  });
});

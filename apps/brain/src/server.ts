import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { PROTOCOL_VERSION } from "@ms-minutes/protocol";
import type { Config } from "./config.js";
import { BodyRegistry } from "./modules/bodies/registry.js";
import { EventBus } from "./modules/events/event-bus.js";
import { registerBodyGateway } from "./modules/gateway/gateway.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;

export async function buildServer(config: Config) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const registry = new BodyRegistry();
  const bus = new EventBus((err, event) =>
    app.log.error({ err, event: event.type }, "event handler failed"),
  );

  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get("/health", async () => ({ status: "ok", protocolVersion: PROTOCOL_VERSION }));

  app.get("/api/bodies", async () => ({
    bodies: registry.list().map((b) => ({
      id: b.id,
      type: b.type,
      firmware: b.firmware,
      capabilities: b.capabilities,
      connectedAt: b.connectedAt.toISOString(),
      lastSeenAt: b.lastSeenAt.toISOString(),
    })),
  }));

  registerBodyGateway(app, { config, registry, bus });

  return { app, registry, bus };
}

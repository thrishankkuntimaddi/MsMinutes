import type { FastifyInstance } from "fastify";
import { BodyConnection, type GatewayDeps } from "./body-connection.js";

export const BODY_SOCKET_PATH = "/ws";

/** Registers the WebSocket endpoint every body connects to. */
export function registerBodyGateway(
  app: FastifyInstance,
  deps: Omit<GatewayDeps, "connections" | "log">,
): void {
  const connections: GatewayDeps["connections"] = new Map();
  app.get(BODY_SOCKET_PATH, { websocket: true }, (socket, request) => {
    new BodyConnection(socket, { ...deps, connections, log: request.log }).start();
  });
}

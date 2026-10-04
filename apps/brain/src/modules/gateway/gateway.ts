import type { FastifyInstance } from "fastify";
import type { BrainToBodyMessage } from "@ms-minutes/protocol";
import { BodyConnection, type GatewayDeps } from "./body-connection.js";

export const BODY_SOCKET_PATH = "/ws";

/** How the rest of the brain sends directives to a connected body. */
export type BodySender = (message: BrainToBodyMessage) => boolean;

/** Registers the WebSocket endpoint every body connects to. */
export function registerBodyGateway(
  app: FastifyInstance,
  deps: Omit<GatewayDeps, "connections" | "log">,
): { send: BodySender } {
  const connections: GatewayDeps["connections"] = new Map();
  app.get(BODY_SOCKET_PATH, { websocket: true }, (socket, request) => {
    new BodyConnection(socket, { ...deps, connections, log: request.log }).start();
  });
  return {
    // Messages are addressed by their envelope's bodyId.
    send: (message) => connections.get(message.bodyId)?.send(message) ?? false,
  };
}

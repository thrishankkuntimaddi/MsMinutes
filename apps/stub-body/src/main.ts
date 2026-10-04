// A minimal terminal body: says hello, keeps a heartbeat, and prints what the brain sends.
import { WebSocket } from "ws";
import {
  bodyMessage,
  decodeBrainMessage,
  encode,
  type BodyToBrainMessage,
} from "@ms-minutes/protocol";

const url = process.env.BRAIN_URL ?? "ws://127.0.0.1:7700/ws";
const bodyId = process.env.BODY_ID ?? "stub-01";

const ws = new WebSocket(url);
let heartbeat: NodeJS.Timeout | undefined;

const send = (message: BodyToBrainMessage) => ws.send(encode(message));

ws.on("open", () => {
  console.log(`→ connected to ${url}, sending hello as "${bodyId}"`);
  send(
    bodyMessage("hello", bodyId, {
      bodyType: "stub",
      firmware: "0.1.0",
      capabilities: [
        { name: "speak", description: "Play synthesized speech", riskTier: 0 },
        { name: "express", description: "Show an emotion on the character", riskTier: 0 },
      ],
    }),
  );
});

ws.on("message", (raw) => {
  const result = decodeBrainMessage(raw.toString());
  if (!result.ok) {
    console.error(`✗ brain sent an invalid message (${result.code}): ${result.error}`);
    return;
  }
  const message = result.message;
  console.log(`← ${message.type}`, JSON.stringify(message.payload));

  if (message.type === "welcome") {
    const { persona, heartbeatIntervalMs } = message.payload;
    console.log(
      `✓ ${persona.name} is here. Heartbeat every ${heartbeatIntervalMs} ms. Ctrl+C to leave.`,
    );
    heartbeat = setInterval(() => send(bodyMessage("heartbeat", bodyId, {})), heartbeatIntervalMs);
  }
});

ws.on("close", (code, reason) => {
  clearInterval(heartbeat);
  console.log(`✗ disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""})`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => console.error(`✗ ${err.message}`));

process.once("SIGINT", () => ws.close(1000, "bye"));

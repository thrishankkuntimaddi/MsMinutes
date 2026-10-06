// A terminal body: type to talk, and see her replies and expressions as they stream in.
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import {
  bodyMessage,
  decodeBrainMessage,
  encode,
  type BodyToBrainMessage,
} from "@ms-minutes/protocol";

const url = process.env.BRAIN_URL ?? "ws://127.0.0.1:7700/ws";
const bodyId = process.env.BODY_ID ?? "stub-01";
const verbose = process.env.VERBOSE === "1";

const ws = new WebSocket(url);
const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "you › " });
let heartbeat: NodeJS.Timeout | undefined;
let name = "brain";
/** Lines typed (or piped) before she's here wait for her welcome. */
let ready = false;
const pending: string[] = [];

const send = (message: BodyToBrainMessage) => ws.send(encode(message));
const write = (text: string) => process.stdout.write(text);

ws.on("open", () => {
  console.log(`connected to ${url} as "${bodyId}"`);
  send(
    bodyMessage("hello", bodyId, {
      bodyType: "stub",
      firmware: "0.2.0",
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
    console.error(`\n✗ brain sent an invalid message (${result.code}): ${result.error}`);
    return;
  }
  const message = result.message;
  if (verbose) console.log(`\n← ${message.type} ${JSON.stringify(message.payload)}`);

  switch (message.type) {
    case "welcome": {
      name = message.payload.persona.name;
      heartbeat = setInterval(
        () => send(bodyMessage("heartbeat", bodyId, {})),
        message.payload.heartbeatIntervalMs,
      );
      console.log(`✓ ${name} is here. Type to talk, Ctrl+C to leave.\n`);
      ready = true;
      for (const text of pending.splice(0)) say(text);
      input.prompt();
      break;
    }
    case "state.set":
      if (message.payload.mode === "thinking") write(`${name} › `);
      if (message.payload.mode === "idle") {
        write("\n\n");
        input.prompt();
      }
      break;
    case "expression.set":
      write(`[${message.payload.affect} ${message.payload.intensity.toFixed(1)}] `);
      break;
    case "speech.text.delta":
      write(message.payload.text);
      break;
    case "error":
      write(`\n✗ ${message.payload.code}: ${message.payload.message}`);
      break;
  }
});

const say = (text: string) => send(bodyMessage("event.utterance.text", bodyId, { text }));

input.on("line", (line) => {
  const text = line.trim();
  if (!text) return input.prompt();
  if (ready) say(text);
  else pending.push(text);
});

ws.on("close", (code, reason) => {
  clearInterval(heartbeat);
  console.log(`\n✗ disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""})`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => console.error(`✗ ${err.message}`));

// Ctrl+C or end of piped input.
input.on("SIGINT", () => ws.close(1000, "bye"));
input.on("close", () => ws.close(1000, "bye"));

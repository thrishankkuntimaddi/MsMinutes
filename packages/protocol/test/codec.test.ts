import { describe, expect, it } from "vitest";
import {
  bodyMessage,
  brainMessage,
  decodeBodyMessage,
  decodeBrainMessage,
  encode,
  PROTOCOL_VERSION,
} from "../src/index.js";

const hello = () =>
  bodyMessage("hello", "desk-01", {
    bodyType: "desk_companion",
    firmware: "0.1.0",
    capabilities: [
      { name: "speak", riskTier: 0 },
      { name: "display.mode", description: "Switch the clock face mode", riskTier: 0 },
    ],
  });

describe("body → brain", () => {
  it("round-trips a hello", () => {
    const result = decodeBodyMessage(encode(hello()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe("hello");
      expect(result.message.v).toBe(PROTOCOL_VERSION);
    }
  });

  it("rejects non-JSON", () => {
    expect(decodeBodyMessage("{nope")).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("rejects an unsupported protocol version and keeps the id for correlation", () => {
    const raw = JSON.stringify({ ...hello(), v: 2 });
    expect(decodeBodyMessage(raw)).toMatchObject({
      ok: false,
      code: "unsupported_version",
      id: expect.any(String),
      bodyId: "desk-01",
    });
  });

  it("rejects unknown message types", () => {
    const raw = JSON.stringify({ ...hello(), type: "teleport" });
    expect(decodeBodyMessage(raw)).toMatchObject({ ok: false, code: "invalid_message" });
  });

  it("rejects duplicate capability names", () => {
    const msg = hello();
    msg.payload.capabilities.push({ name: "speak", riskTier: 1 });
    expect(decodeBodyMessage(encode(msg))).toMatchObject({ ok: false, code: "invalid_message" });
  });

  it("rejects malformed body ids", () => {
    const raw = JSON.stringify({ ...hello(), bodyId: "Desk 01" });
    expect(decodeBodyMessage(raw)).toMatchObject({ ok: false, code: "invalid_message" });
  });
});

describe("brain → body", () => {
  it("round-trips an expression with replyTo", () => {
    const msg = brainMessage(
      "expression.set",
      "desk-01",
      { affect: "happy", intensity: 0.7, transitionMs: 300 },
      "req-1",
    );
    const result = decodeBrainMessage(encode(msg));
    expect(result).toMatchObject({ ok: true, message: { replyTo: "req-1" } });
  });

  it("rejects out-of-range intensity", () => {
    const msg = brainMessage("expression.set", "desk-01", {
      affect: "happy",
      intensity: 1.5,
      transitionMs: 300,
    });
    expect(decodeBrainMessage(encode(msg))).toMatchObject({ ok: false, code: "invalid_message" });
  });
});

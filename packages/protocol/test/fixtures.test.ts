import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BodyToBrainMessage,
  BrainToBodyMessage,
  decodeBodyMessage,
  decodeBrainMessage,
} from "../src/index.js";

/**
 * Protocol contract fixtures (ARCHITECTURE §17): one valid example of every message type,
 * for any body implementation to test its codec against (the firmware's host tests read
 * these same files), plus messages the brain must reject and why.
 */
const fixtures = new URL("../fixtures/", import.meta.url);
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as T;

type Direction = "body-to-brain" | "brain-to-body";
type Invalid = {
  name: string;
  direction: Direction;
  code: string;
  message?: unknown;
  raw?: string;
};

const typesOf = (union: typeof BodyToBrainMessage | typeof BrainToBodyMessage) =>
  union.options.map((o) => o.shape.type.value).sort();

const decoders = { "body-to-brain": decodeBodyMessage, "brain-to-body": decodeBrainMessage };
const unions = { "body-to-brain": BodyToBrainMessage, "brain-to-body": BrainToBodyMessage };

for (const direction of ["body-to-brain", "brain-to-body"] as Direction[]) {
  describe(`${direction} fixtures`, () => {
    const examples = load<Record<string, { type: string }>>(`${direction}.json`);

    it("cover every message type, and nothing else", () => {
      expect(Object.keys(examples).sort()).toEqual(typesOf(unions[direction]));
    });

    for (const [type, message] of Object.entries(examples)) {
      it(`${type} is valid and keyed by its own type`, () => {
        expect(message.type).toBe(type);
        const result = decoders[direction](JSON.stringify(message));
        expect(result).toMatchObject({ ok: true, message: { type } });
      });
    }
  });
}

describe("invalid fixtures", () => {
  for (const f of load<Invalid[]>("invalid.json")) {
    it(`${f.name} → ${f.code}`, () => {
      const raw = f.raw ?? JSON.stringify(f.message);
      expect(decoders[f.direction](raw)).toMatchObject({ ok: false, code: f.code });
    });
  }
});

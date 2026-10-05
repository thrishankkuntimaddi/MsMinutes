import type { FastifyBaseLogger } from "fastify";
import { brainMessage } from "@ms-minutes/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { BodySender } from "../gateway/gateway.js";
import { isEcho, to16k, type STT } from "./stt.js";

export type HearingDeps = {
  stt: STT;
  send: BodySender;
  log: FastifyBaseLogger;
  /** Starts a turn for what was heard. */
  onUtterance: (bodyId: string, text: string, sttMs: number) => void;
  /** What she said lately to this body, to catch her own voice echoing back. */
  recentSpeech: (bodyId: string) => string;
};

/** Longer than this is not one utterance; the rest is ignored. */
const MAX_SECONDS = 30;
/** Shorter than this is a cough or a click. */
const MIN_SECONDS = 0.25;
/** Quieter than this (RMS) is room noise. */
const MIN_RMS = 0.004;

type Utterance = { rate: number; parts: Float32Array[]; samples: number; nextSeq: number };

/**
 * Turns a body's microphone audio (`event.audio.chunk` … `event.audio.end`, sent after the
 * body's VAD decides you've spoken) into text, and that text into a turn (ARCHITECTURE §10).
 */
export class Hearing {
  readonly #deps: HearingDeps;
  readonly #open = new Map<string, Utterance>();

  constructor(deps: HearingDeps) {
    this.#deps = deps;
  }

  attach(bus: EventBus): void {
    bus.on("body.message", ({ bodyId, message }) => {
      if (message.type === "event.audio.chunk") this.#chunk(bodyId, message.payload);
      if (message.type === "event.audio.end") void this.#end(bodyId);
    });
    bus.on("body.disconnected", ({ bodyId }) => this.#open.delete(bodyId));
  }

  #chunk(
    bodyId: string,
    chunk: { seq: number; codec: string; sampleRate: number; data: string },
  ): void {
    if (chunk.codec !== "pcm16") {
      this.#deps.log.warn({ bodyId, codec: chunk.codec }, "unsupported uplink codec");
      return;
    }
    let u = this.#open.get(bodyId);
    // seq 0 starts a new utterance, whatever was left of the last one.
    if (!u || chunk.seq === 0 || u.rate !== chunk.sampleRate) {
      u = { rate: chunk.sampleRate, parts: [], samples: 0, nextSeq: 0 };
      this.#open.set(bodyId, u);
    }
    if (chunk.seq !== u.nextSeq) {
      this.#deps.log.warn(
        { bodyId, expected: u.nextSeq, got: chunk.seq },
        "audio chunk out of order",
      );
    }
    u.nextSeq = chunk.seq + 1;
    if (u.samples >= MAX_SECONDS * u.rate) return;

    const bytes = Buffer.from(chunk.data, "base64");
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const samples = Float32Array.from(pcm, (v) => v / 0x8000);
    u.parts.push(samples);
    u.samples += samples.length;
  }

  async #end(bodyId: string): Promise<void> {
    const u = this.#open.get(bodyId);
    this.#open.delete(bodyId);
    const heard = (text: string) => this.#deps.send(brainMessage("transcript", bodyId, { text }));
    if (!u || u.samples < MIN_SECONDS * u.rate) return void heard("");

    const all = new Float32Array(u.samples);
    let at = 0;
    for (const part of u.parts) {
      all.set(part, at);
      at += part.length;
    }
    let sum = 0;
    for (const v of all) sum += v * v;
    if (Math.sqrt(sum / all.length) < MIN_RMS) return void heard("");

    const started = performance.now();
    let text: string;
    try {
      text = cleanTranscript(await this.#deps.stt.transcribe(to16k(all, u.rate)));
    } catch (err) {
      this.#deps.log.warn({ err, bodyId }, "speech recognition failed");
      return void heard("");
    }
    const sttMs = Math.round(performance.now() - started);

    if (text && isEcho(text, this.#deps.recentSpeech(bodyId))) {
      this.#deps.log.info({ bodyId, text }, "ignored her own voice echoing back");
      text = "";
    }
    heard(text);
    this.#deps.log.info(
      { bodyId, text, sttMs, seconds: +(all.length / u.rate).toFixed(2) },
      "heard",
    );
    if (text) this.#deps.onUtterance(bodyId, text, sttMs);
  }
}

/** Speech models sometimes emit noise markers or a lone filler for silence. */
export function cleanTranscript(text: string): string {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z0-9]/i.test(t)) return "";
  if (/^(you|uh|um|hmm|thank you\.?|thanks for watching!?)$/i.test(t)) return "";
  return t;
}

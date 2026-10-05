import { MicVAD } from "@ricky0123/vad-web";

export type EarsOptions = {
  /** Someone may be starting to talk (not yet confirmed). */
  onMaybeSpeech?: () => void;
  /** Confirmed speech: long and loud enough to be a person, not a click. */
  onSpeech?: () => void;
  /** A whole utterance, 16 kHz mono. */
  onUtterance: (samples: Float32Array) => void;
  /** It was nothing after all. */
  onMisfire?: () => void;
};

/** Normal sensitivity, and stricter while she talks so her own voice doesn't count. */
const CALM = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 250 };
const WHILE_SHE_TALKS = {
  positiveSpeechThreshold: 0.8,
  negativeSpeechThreshold: 0.6,
  minSpeechMs: 400,
};

/**
 * Hands-free listening (ARCHITECTURE §10): a voice-activity detector (Silero, in the
 * browser) decides when you start and stop talking, so only real utterances leave the
 * body. Echo cancellation keeps her voice out of the mic where the browser can.
 */
export class Ears {
  readonly #options: EarsOptions;
  #vad: MicVAD | null = null;
  #on = false;

  constructor(options: EarsOptions) {
    this.#options = options;
  }

  get on(): boolean {
    return this.#on;
  }

  async start(): Promise<void> {
    this.#vad ??= await MicVAD.new({
      model: "v5",
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      startOnLoad: false,
      redemptionMs: 500,
      preSpeechPadMs: 300,
      ...CALM,
      getStream: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      onSpeechStart: () => this.#options.onMaybeSpeech?.(),
      onSpeechRealStart: () => this.#options.onSpeech?.(),
      onSpeechEnd: (audio) => this.#options.onUtterance(audio),
      onVADMisfire: () => this.#options.onMisfire?.(),
    });
    await this.#vad.start();
    this.#on = true;
  }

  async stop(): Promise<void> {
    this.#on = false;
    await this.#vad?.pause();
  }

  /** While she's speaking, only clear, sustained speech should count. */
  setSheIsTalking(talking: boolean): void {
    this.#vad?.setOptions(talking ? WHILE_SHE_TALKS : CALM);
  }
}

/** 16 kHz float samples → base64 PCM16 chunks of about a second each. */
export function toPcm16Chunks(samples: Float32Array, perChunk = 16_000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < samples.length; i += perChunk) {
    const part = samples.subarray(i, i + perChunk);
    const pcm = new Int16Array(part.length);
    for (let j = 0; j < part.length; j++) {
      const s = Math.max(-1, Math.min(1, part[j]!));
      pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let k = 0; k < bytes.length; k += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    }
    chunks.push(btoa(binary));
  }
  return chunks;
}

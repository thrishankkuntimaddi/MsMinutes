import { ACTIONS } from "@ms-minutes/character";
import {
  CloseCode,
  bodyMessage,
  decodeBrainMessage,
  encode,
  type BodyToBrainMessage,
  type BrainToBodyMessage,
} from "@ms-minutes/protocol";

/** "replaced": she's open in another tab, which now has her; this one stops reconnecting. */
export type LinkStatus = "connecting" | "online" | "offline" | "replaced";

export type BrainLinkOptions = {
  url: string;
  bodyId: string;
  onMessage: (message: BrainToBodyMessage) => void;
  onStatus: (status: LinkStatus) => void;
};

const RETRY_MS = [1000, 2000, 4000, 8000];

/** This body's connection to the brain: hello, heartbeats, and reconnecting when it drops. */
export class BrainLink {
  readonly #options: BrainLinkOptions;
  #socket: WebSocket | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #attempt = 0;
  #online = false;

  constructor(options: BrainLinkOptions) {
    this.#options = options;
  }

  get online(): boolean {
    return this.#online;
  }

  connect(): void {
    const { url, bodyId, onStatus } = this.#options;
    onStatus("connecting");
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.onopen = () =>
      this.#send(
        bodyMessage("hello", bodyId, {
          bodyType: "web_body",
          firmware: "0.3.0",
          capabilities: [
            { name: "speak", description: "Speak aloud through the browser", riskTier: 0 },
            { name: "speak.audio", description: "Play her synthesized voice", riskTier: 0 },
            {
              name: "animate",
              description:
                "Move her body: walk, jump, turn around and so on. come_out steps out of the TV " +
                "into the room; go_home climbs back into the TV",
              schema: {
                type: "object",
                properties: {
                  action: { type: "string", enum: [...ACTIONS, "come_out", "go_home"] },
                },
                required: ["action"],
              },
              riskTier: 0,
            },
            { name: "listen", description: "Hear the user through the microphone", riskTier: 2 },
            { name: "display.timer", description: "Show running timers on her face", riskTier: 0 },
            {
              name: "alarm.ring",
              description: "Ring her bells when a timer or reminder fires",
              riskTier: 0,
            },
            { name: "express", description: "Show an emotion on her face", riskTier: 0 },
          ],
        }),
      );

    socket.onmessage = (event) => {
      const result = decodeBrainMessage(String(event.data));
      if (!result.ok) {
        console.warn(`brain sent an invalid message (${result.code}): ${result.error}`);
        return;
      }
      const message = result.message;
      if (message.type === "welcome") {
        this.#attempt = 0;
        this.#online = true;
        clearInterval(this.#heartbeat);
        this.#heartbeat = setInterval(
          () => this.#send(bodyMessage("heartbeat", bodyId, {})),
          message.payload.heartbeatIntervalMs,
        );
        onStatus("online");
      }
      this.#options.onMessage(message);
    };

    socket.onclose = (event) => {
      clearInterval(this.#heartbeat);
      this.#online = false;
      this.#socket = null;
      // Another tab took over this body. Reconnecting would just take it back, forever.
      if (event.code === CloseCode.Replaced) return onStatus("replaced");
      onStatus("offline");
      const delay = RETRY_MS[Math.min(this.#attempt++, RETRY_MS.length - 1)];
      setTimeout(() => this.connect(), delay);
    };
  }

  say(text: string): boolean {
    return this.#send(bodyMessage("event.utterance.text", this.#options.bodyId, { text }));
  }

  result(callId: string, ok: boolean, error?: string): void {
    this.#send(
      bodyMessage("capability.result", this.#options.bodyId, {
        callId,
        ok,
        ...(error ? { error: { code: "unsupported", message: error } } : {}),
      }),
    );
  }

  /** One utterance from the mic: PCM16 chunks, then the end marker. */
  utterance(chunks: string[], sampleRate = 16_000): boolean {
    if (!this.#online) return false;
    chunks.forEach((data, seq) =>
      this.#send(
        bodyMessage("event.audio.chunk", this.#options.bodyId, {
          seq,
          codec: "pcm16",
          sampleRate,
          data,
        }),
      ),
    );
    return this.#send(bodyMessage("event.audio.end", this.#options.bodyId, {}));
  }

  interrupt(): void {
    this.#send(bodyMessage("event.interrupt", this.#options.bodyId, {}));
  }

  #send(message: BodyToBrainMessage): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(encode(message));
    return true;
  }
}

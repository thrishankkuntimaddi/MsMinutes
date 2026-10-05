/** The slice of the Web Speech API used here; TypeScript's DOM types don't include it. */
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>>;
};
type RecognitionCtor = new () => Recognition;

export type ListenOptions = {
  /** Words heard so far, updated as she listens. */
  onInterim?: (text: string) => void;
};

/**
 * Hears the user with the browser's speech recognition (Chrome, Edge, Safari).
 * Speech-to-text stays on the body; only the final words go to the brain.
 */
export class Listener {
  readonly #Ctor: RecognitionCtor | undefined;
  #active: Recognition | null = null;

  constructor() {
    const w = window as unknown as {
      SpeechRecognition?: RecognitionCtor;
      webkitSpeechRecognition?: RecognitionCtor;
    };
    this.#Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }

  get supported(): boolean {
    return this.#Ctor !== undefined;
  }

  get listening(): boolean {
    return this.#active !== null;
  }

  /** Listens for one utterance. Resolves with what was said, or "" if nothing was heard. */
  listen(options: ListenOptions = {}): Promise<string> {
    if (!this.#Ctor) return Promise.reject(new Error("Speech recognition isn't available here."));
    this.stop();
    const rec = new this.#Ctor();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    this.#active = rec;

    return new Promise((resolve, reject) => {
      let finalText = "";
      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          if (result.isFinal) finalText += result[0]!.transcript;
          else interim += result[0]!.transcript;
        }
        options.onInterim?.((finalText + interim).trim());
      };
      rec.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        this.#active = null;
        reject(new Error(describe(event.error)));
      };
      rec.onend = () => {
        if (this.#active === rec) this.#active = null;
        resolve(finalText.trim());
      };
      rec.start();
    });
  }

  /** Stops listening; whatever was heard so far is kept. */
  stop(): void {
    this.#active?.stop();
    this.#active = null;
  }
}

function describe(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it in the address bar and try again.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs a network connection.";
    default:
      return `Speech recognition failed (${error}).`;
  }
}

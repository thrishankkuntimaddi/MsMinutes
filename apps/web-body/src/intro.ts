import { CharacterRig, isAction } from "@ms-minutes/character";
import type { Affect } from "@ms-minutes/protocol";
import { AudioVoice } from "./audio-voice.js";
import { Ears, toPcm16Chunks } from "./ears.js";
import type { BodyMode, BrainToBodyMessage } from "@ms-minutes/protocol";
import { BrainLink, type LinkStatus } from "./brain.js";
import { Fx } from "./fx.js";
import { Listener } from "./listener.js";
import { ClockRenderer } from "./renderer.js";
import { Speaker } from "./speaker.js";
import { VoiceQueue } from "./voice-queue.js";

const GREETING = "Hi! Welcome to the TVA. My name is Miss Minutes.";
/** The greeting pre-rendered in her neural voice (see apps/brain/scripts/say.ts). */
const GREETING_AUDIO = "/voice/greeting.wav";
const BODY_ID = "web-01";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const rig = new CharacterRig();
const renderer = new ClockRenderer($<HTMLCanvasElement>("face"));
const speaker = new Speaker();
const listener = new Listener();
const fx = new Fx();

const screen = $("screen");
const caption = $("caption");
const staticCanvas = $<HTMLCanvasElement>("static");
const input = $<HTMLInputElement>("say");
const mic = $<HTMLButtonElement>("mic");
const heard = $("heard");
const root = document.documentElement.style;

// ---------- Her, every frame ----------

let visible = false;
let staticOn = false;
let last = performance.now();

function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  rig.setViseme(audio?.sample() ?? speaker.sample(now));
  const f = rig.update(dt);
  if (visible) renderer.draw(f);
  if (staticOn) drawStatic();
  root.setProperty("--talk", Math.max(0, f.mouthOpen).toFixed(3));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Her eyes follow you around the room, unless she's talking to you.
addEventListener("pointermove", (e) => {
  if (!visible || talking() || listener.listening) return;
  const p = renderer.toFaceSpace(e.clientX, e.clientY);
  rig.lookAt(p.x, p.y, 1.2);
});

// ---------- Her voice ----------

/** Things she does on particular words of the scripted greeting. */
let cues: Record<string, () => void> = {};
let spans: HTMLSpanElement[] = [];

const voice = new VoiceQueue(speaker, {
  rate: 0.98,
  pitch: 1.25,
  onSentence: (sentence) => {
    spans = setCaption(sentence);
  },
  onWord: (i, word) => {
    spans[i]?.classList.add("on");
    cues[word.toLowerCase()]?.();
  },
  onBusy: (busy) => {
    if (busy) rig.lookAt(0, 0.05, 600);
    else {
      rig.lookAt(0, 0, 0.1);
      spans.forEach((s) => s.classList.add("on"));
      fadeCaptionSoon();
    }
    ears.setSheIsTalking(busy);
    updateMode();
  },
});

/** Her neural voice, once the page may play sound. */
let audio: AudioVoice | null = null;
/** The brain sends her voice as audio; otherwise the browser speaks the text. */
let brainSpeaks = false;

function startAudio(): void {
  const graph = fx.audio;
  if (!graph || audio) return;
  audio = new AudioVoice(graph.ctx, graph.out, {
    onSentence: (words) => {
      spans = setCaption(words.join(" "));
    },
    onWord: (i) => {
      spans[i]?.classList.add("on");
      const word = spans[i]?.textContent?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
      cues[word]?.();
    },
    onBusy: (busy) => {
      if (busy) rig.lookAt(0, 0.05, 600);
      else {
        rig.lookAt(0, 0, 0.1);
        spans.forEach((s) => s.classList.add("on"));
        fadeCaptionSoon();
      }
      ears.setSheIsTalking(busy);
      updateMode();
    },
  });
}

const talking = () => voice.busy || (audio?.busy ?? false);

let captionTimer: ReturnType<typeof setTimeout> | undefined;

/** Captions fade a few seconds after she stops, so they don't sit over her feet. */
function fadeCaptionSoon(): void {
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => caption.classList.add("fade"), 3500);
}

function setCaption(text: string): HTMLSpanElement[] {
  clearTimeout(captionTimer);
  caption.classList.remove("fade");
  caption.replaceChildren();
  const words: HTMLSpanElement[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (/^\s*$/.test(part)) {
      caption.append(part);
      continue;
    }
    const span = document.createElement("span");
    span.className = "w";
    span.textContent = part;
    caption.append(span);
    // Same word split as the speaker, so word N lights up when she says word N.
    if (/[A-Za-z0-9']/.test(part)) words.push(span);
  }
  return words;
}

/** Browsers load voices lazily; give them a moment so she doesn't use a robot default. */
function voicesReady(): Promise<void> {
  if (!speaker.supported || speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1200);
  });
}

// ---------- Her brain ----------

let brainMode: BodyMode = "idle";
/** Turns sent to the brain that haven't finished yet. */
let inFlight = 0;
/** Older turns still queued in the brain that were interrupted before they started. */
let skipTurns = 0;
/** The brain's current turn was interrupted: drop whatever it still says. */
let turnIgnored = false;

const link = new BrainLink({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  bodyId: BODY_ID,
  onStatus: showLink,
  onMessage,
});

function onMessage(message: BrainToBodyMessage): void {
  switch (message.type) {
    case "state.set": {
      const mode = message.payload.mode;
      if (mode === "thinking") {
        // Every turn starts by thinking: decide now whether this one was interrupted.
        turnIgnored = skipTurns > 0;
        if (turnIgnored) skipTurns--;
      }
      if (mode === "idle") inFlight = Math.max(0, inFlight - 1);
      brainMode = turnIgnored && mode !== "idle" ? "idle" : mode;
      updateMode();
      break;
    }
    case "welcome":
      brainSpeaks = message.payload.audio ?? false;
      brainHears = message.payload.hearing ?? false;
      mic.title = brainHears ? "Hands-free: click to start or stop listening" : "Click to talk";
      break;
    case "transcript": {
      const text = message.payload.text;
      heard.textContent = text;
      heard.classList.toggle("missed", !text);
      if (!text) {
        heard.textContent = "(didn't catch that)";
        setTimeout(
          () => heard.textContent === "(didn't catch that)" && (heard.textContent = ""),
          1800,
        );
      } else {
        // The brain starts a turn for it; count it so interrupts can skip it later.
        inFlight++;
        rig.setExpression("curious", 0.4);
      }
      updateMode();
      break;
    }
    case "expression.set":
      if (turnIgnored) break;
      express(message.payload.affect, message.payload.intensity);
      rig.setExpression(
        message.payload.affect,
        message.payload.intensity,
        message.payload.blend ?? [],
      );
      break;
    case "speech.text.delta":
      if (!turnIgnored && !brainSpeaks) voice.push(message.payload.text);
      break;
    case "speech.marks":
      if (!turnIgnored && message.payload.seq !== undefined) {
        audio?.marks(message.payload.seq, message.payload.marks);
      }
      break;
    case "speech.audio.chunk":
      if (!turnIgnored && message.payload.codec === "pcm16") {
        audio?.pcm16(message.payload.seq, message.payload.sampleRate, message.payload.data);
      }
      break;
    case "speech.end":
      if (!turnIgnored && !brainSpeaks) voice.flush();
      break;
    case "speech.cancel":
      voice.cancel();
      audio?.cancel();
      break;
    case "capability.call": {
      const { callId, name, args } = message.payload;
      const action = String(args.action ?? "");
      if (name === "animate" && isAction(action) && !turnIgnored) {
        rig.act(action);
        link.result(callId, true);
      } else {
        link.result(callId, false, `can't ${name} ${action}`);
      }
      break;
    }
    case "error":
      if (message.payload.code === "llm_unavailable") {
        status(message.payload.message, "offline");
        rig.setExpression("concerned", 0.6);
        voice.say("Hmm. I can't reach my thinking cap right now. The status line below says why.");
      } else {
        console.warn(`brain error ${message.payload.code}: ${message.payload.message}`);
      }
      break;
    default:
      break;
  }
}

/** Big feelings move her whole body, not just her face. */
let lastAffect: Affect = "neutral";
function express(affect: Affect, intensity: number): void {
  if (affect === lastAffect) return;
  lastAffect = affect;
  if (intensity < 0.45) return;
  if (affect === "excited") rig.act("jump");
  else if (affect === "laughing" || affect === "surprised") rig.hop(0.6);
  else if (affect === "happy" && intensity > 0.8) rig.hop(0.4);
}

/** One face, one mode: what she's doing locally wins over what the brain last said. */
function updateMode(): void {
  const mode: BodyMode =
    listener.listening || hearingYou
      ? "listening"
      : talking()
        ? "speaking"
        : brainMode === "thinking"
          ? "thinking"
          : "idle";
  rig.setMode(mode);
  $("led").classList.toggle("on", mode !== "idle" || link.online);
}

function showLink(state: LinkStatus): void {
  if (state === "online") status("Connected · her brain is listening", "online");
  else if (state === "connecting") status("Connecting to her brain…");
  else if (state === "replaced") {
    status("She's open in another tab · click here to bring her back", "offline");
    $("status").onclick = () => {
      $("status").onclick = null;
      link.connect();
    };
  } else status("Brain offline · start it with  pnpm dev:brain", "offline");
}

function status(text: string, kind?: "online" | "offline"): void {
  $("status").textContent = text;
  $("dot").className = `dot ${kind ?? ""}`;
}

/** Stop her mid-sentence: the user has the floor. */
function interrupt(): void {
  if (!talking() && brainMode === "idle") return;
  voice.cancel();
  audio?.cancel();
  link.interrupt();
  if (brainMode !== "idle") {
    turnIgnored = true;
    skipTurns += Math.max(0, inFlight - 1);
  } else {
    skipTurns += inFlight;
  }
  brainMode = "idle";
  updateMode();
}

function send(text: string): void {
  text = text.trim();
  if (!text) return;
  interrupt();
  heard.textContent = text;
  input.value = "";
  if (!link.say(text)) {
    rig.setExpression("concerned", 0.5);
    voice.say("I can't hear my brain right now. Start it up and I'll be right with you.");
    return;
  }
  inFlight++;
  rig.setExpression("curious", 0.4);
}

// ---------- Talking to her ----------

$<HTMLFormElement>("dock").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});

/** The brain transcribes our microphone itself, so we can listen hands-free. */
let brainHears = false;
/** You're talking right now (hands-free). */
let hearingYou = false;

const ears = new Ears({
  onMaybeSpeech: () => {
    hearingYou = true;
    rig.lookAt(0, 0.05, 30);
    updateMode();
  },
  onSpeech: () => {
    // Barge-in: you started talking over her (or while she was thinking).
    if (talking() || brainMode !== "idle") interrupt();
  },
  onUtterance: (samples) => {
    hearingYou = false;
    if (link.utterance(toPcm16Chunks(samples))) {
      heard.textContent = "…";
    } else {
      rig.setExpression("concerned", 0.5);
      status("Brain offline · I can't hear you until it's back", "offline");
    }
    updateMode();
  },
  onMisfire: () => {
    hearingYou = false;
    updateMode();
  },
});

/** Hands-free on/off when the brain can hear; otherwise the browser's recognition. */
async function toggleMic(): Promise<void> {
  if (!brainHears) return listen();
  try {
    if (ears.on) {
      await ears.stop();
      hearingYou = false;
      status("Microphone off · type, or click the mic", link.online ? "online" : undefined);
    } else {
      await ears.start();
      status("Listening · just talk to her", "online");
    }
  } catch (error) {
    status(micError(error), "offline");
  }
  mic.classList.toggle("live", ears.on);
  input.placeholder = ears.on ? "Just talk, or type here…" : "Say something to Miss Minutes…";
  updateMode();
}

function micError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError")
    return "Microphone blocked. Allow it in the address bar and try again.";
  if (name === "NotFoundError") return "No microphone found.";
  return `Microphone failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Click-to-talk with the browser's own speech recognition (when the brain can't hear). */
async function listen(): Promise<void> {
  if (!listener.supported) {
    status("This browser can't hear you; type instead (Chrome, Edge or Safari can).", "offline");
    input.focus();
    return;
  }
  if (listener.listening) {
    listener.stop();
    return;
  }
  interrupt();
  mic.classList.add("live");
  input.placeholder = "Listening…";
  rig.lookAt(0, 0.05, 30);
  const listening = listener.listen({ onInterim: (text) => (input.value = text) });
  updateMode();
  try {
    send(await listening);
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), "offline");
  } finally {
    mic.classList.remove("live");
    input.placeholder = "Say something to Miss Minutes…";
    updateMode();
  }
}

mic.addEventListener("click", () => void toggleMic());

// ---------- Screen static ----------

const staticCtx = staticCanvas.getContext("2d")!;
staticCanvas.width = 160;
staticCanvas.height = 120;
const staticImage = staticCtx.createImageData(160, 120);

function drawStatic(): void {
  const d = staticImage.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() * 255;
    d[i] = v;
    d[i + 1] = v * 0.86;
    d[i + 2] = v * 0.7;
    d[i + 3] = 255;
  }
  staticCtx.putImageData(staticImage, 0, 0);
}

// ---------- Room atmosphere: dust in the light, film grain ----------

function startDust(): void {
  const canvas = document.querySelector<HTMLCanvasElement>(".dust")!;
  const ctx = canvas.getContext("2d")!;
  const motes = Array.from({ length: 90 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.4 + Math.random() * 1.6,
    vx: (Math.random() - 0.5) * 0.004,
    vy: -0.002 - Math.random() * 0.006,
    phase: Math.random() * Math.PI * 2,
  }));
  const tick = (t: number) => {
    const dpr = devicePixelRatio || 1;
    const w = innerWidth;
    const h = innerHeight;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.x += (m.vx + Math.sin(t / 2000 + m.phase) * 0.0006) / 60;
      m.y += m.vy / 60;
      if (m.y < -0.02) m.y = 1.02;
      if (m.x < -0.02) m.x = 1.02;
      if (m.x > 1.02) m.x = -0.02;
      // Brighter inside the diagonal light shaft.
      const inBeam = Math.max(0, 1 - Math.abs(m.x - 0.3 - m.y * 0.35) * 5);
      const twinkle = 0.5 + 0.5 * Math.sin(t / 700 + m.phase * 3);
      ctx.fillStyle = `rgba(255, 214, 160, ${(0.08 + inBeam * 0.5) * twinkle})`;
      ctx.beginPath();
      ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reducedMotion) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function makeGrain(): void {
  const c = document.createElement("canvas");
  c.width = c.height = 220;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(220, 220);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  document.querySelector<HTMLElement>(".grain")!.style.backgroundImage = `url(${c.toDataURL()})`;
}

startDust();
makeGrain();

// ---------- The orientation ----------

const GREETING_CUES: Record<string, () => void> = {
  hi: () => {
    rig.setExpression("excited", 0.7);
    rig.wave(1.8);
  },
  welcome: () => rig.setExpression("happy", 1),
  tva: () => {
    rig.setExpression("excited", 0.9);
    rig.ring(0.7);
    fx.bell(0.7);
    rig.hop(0.5);
  },
  my: () => rig.setExpression("happy", 0.9),
  miss: () => rig.setExpression("happy", 1, [{ affect: "curious", weight: 0.3 }]),
  minutes: () => {
    rig.wink("right", 0.45);
    rig.setExpression("happy", 1);
  },
};

let run = 0;

async function orientation(): Promise<void> {
  const me = ++run;
  voice.cancel();
  audio?.cancel();
  caption.replaceChildren();

  // The set warms up.
  screen.classList.remove("on");
  screen.classList.add("off");
  visible = false;
  root.setProperty("--power", "0");
  await wait(250);
  fx.powerOn();
  void screen.offsetWidth; // restart the CSS animation
  screen.classList.replace("off", "on");
  staticOn = true;
  staticCanvas.classList.add("show");
  root.setProperty("--power", "1");
  await wait(500);
  fx.static(0.7);
  await wait(650);

  // She comes running in from the side of the screen…
  visible = true;
  rig.setExpression("excited", 0.7);
  rig.motion.enter(-1);
  staticCanvas.classList.remove("show");
  await wait(350);
  staticOn = false;
  while (rig.motion.busy) await wait(50);
  if (me !== run) return;
  // …skids to a stop, a little surprised to see you.
  rig.setExpression("surprised", 0.7);
  rig.hop(0.8);
  fx.hop();
  await wait(500);
  rig.setExpression("happy", 0.8);
  rig.blink();
  await wait(350);

  // And she says hello, in her own voice when it's available.
  cues = GREETING_CUES;
  try {
    if (!audio) throw new Error("no audio");
    await audio.file(GREETING_AUDIO, GREETING.split(" "));
  } catch {
    await voicesReady();
    voice.say(GREETING);
    while (voice.busy) await wait(100);
  }
  if (me !== run) return;
  cues = {};
  rig.setExpression("happy", 0.85);

  // Then she's yours to talk to.
  await wait(500);
  $("console").hidden = false;
  input.focus({ preventScroll: true });
}

$("begin").addEventListener("click", async () => {
  $("gate").classList.add("gone");
  await fx.init();
  startAudio();
  link.connect();
  void orientation();
});

$("replay").addEventListener("click", () => void orientation());

// Renders a line in her voice to a WAV file, e.g. the browser body's greeting:
//   pnpm --filter @ms-minutes/brain say "Hi! Welcome to the TVA." ../web-body/public/voice/greeting.wav
import { writeFileSync } from "node:fs";
import { KokoroTTS } from "../src/modules/voice/tts.js";

const [text, out = "say.wav"] = process.argv.slice(2);
if (!text) {
  console.error('usage: say "<text>" [out.wav]');
  process.exit(1);
}
const tts = new KokoroTTS({
  voice: process.env.TTS_VOICE ?? "af_heart",
  speed: Number(process.env.TTS_SPEED ?? 1),
});
const { samples, sampleRate } = await tts.synthesize(text);
writeFileSync(out, wav(samples, sampleRate));
console.log(`wrote ${out} (${(samples.length / sampleRate).toFixed(2)} s)`);

function wav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), i * 2),
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

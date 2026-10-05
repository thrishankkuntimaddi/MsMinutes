# ADR-0009: Neural TTS in the brain, streamed as audio

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Browser speech synthesis sounds robotic and differs per device, and the ESP32 body (H3) can't synthesize speech at all. ARCHITECTURE §10 puts a sentence chunker and TTS in the brain, with audio streamed down and the mouth driven by amplitude.

## Decision

- A `TTS` adapter in the brain; the first implementation is Kokoro-82M (`kokoro-js`, ONNX, fp32 on CPU, ~330 MB, cached after first download). fp32 is ~2.5× faster than q8 on CPU.
- Per turn, `SpeechOut` chunks the tag-free text into sentences (the first clause may go early), synthesizes them in order while the model keeps writing, and sends `speech.marks` (estimated word times) followed by `speech.audio.chunk` (PCM16, 24 kHz, ≤ ~4 s each). `speech.end` waits until all audio is sent.
- Bodies opt in with a `speak.audio` capability; `welcome.audio` tells them the brain will speak, so they don't synthesize the text themselves.
- Bodies drive the mouth from the playback's loudness and brightness, as on the ESP32.
- `TTS_PROVIDER=none` leaves speech to the body (browser voices).

## Consequences

- First audio ~1.4 s after the user stops typing with a local model, inside the §10 budget.
- Protocol additions: `welcome.audio`, `speech.marks.seq`, affects `playful`, `shy`, `proud`.
- An interrupted turn stops synthesizing; audio already sent is dropped by the body.

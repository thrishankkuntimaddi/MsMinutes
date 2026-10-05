# ADR-0010: Local hearing in the brain, VAD on the body, real barge-in

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 3 needs hands-free conversation that can be interrupted (ARCHITECTURE §10). The browser's built-in speech recognition sends audio to a cloud service, differs per browser and doesn't exist on the ESP32. Interrupting her only stopped playback on the page; the brain kept writing and synthesizing the old reply, which delayed the next one.

## Decision

- **VAD on the body** (§10.2): the browser body runs Silero VAD (`@ricky0123/vad-web`, assets served locally at `/vad/`). Only finished utterances leave the body, as `event.audio.chunk` (16 kHz PCM16, ~1 s each) followed by `event.audio.end`. The brain never gets an always-on stream.
- **STT in the brain**: an `STT` adapter; the default is Moonshine base (transformers.js, ~0.1–0.2 s per sentence on CPU). Whisper pads every clip to 30 s and was ~7× slower for the same accuracy on short speech. `STT_MODEL` accepts any transformers.js ASR model.
- The brain answers each utterance with a `transcript` message (empty when it heard nothing worth answering) and starts a turn for non-empty text. Blips under 0.25 s, near-silence, filler hallucinations and her own recent words (echo) are dropped.
- `welcome.hearing` tells a body that declared `listen` to send audio; otherwise it falls back to the browser's recognition.
- **Barge-in**: confirmed speech while she talks or thinks makes the body stop playback and send `event.interrupt`. The brain aborts the model stream (`AbortSignal` through the `LLM` interface) and cancels synthesis, including sentences queued in the TTS. The turn's partial reply stays in history, ending in "—", so she knows where she was cut off.
- While she talks, the VAD's thresholds rise, and browser echo cancellation is on, so her own voice doesn't count as the user.

## Consequences

- Measured locally (qwen2.5:3b, Moonshine, Kokoro): transcript 0.1–0.2 s after the VAD closes; first audio ~1.5–1.7 s after the utterance reaches the brain, plus ~0.5 s of VAD end-of-speech wait. An interrupted turn ends within ~20 ms of `event.interrupt` reaching the brain.
- With Ollama, the turn after an interrupt re-reads the whole conversation (the abort invalidates its prompt cache), so it can take several seconds to start.
- Protocol additions: `transcript`, `welcome.hearing`. Laptop speakers without working echo cancellation can still trigger barge-in; headphones avoid it.

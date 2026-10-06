# ADR-0013: Desk companion firmware as a thin client with a shared face

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Phase 7 brings the brain to a real device (ARCHITECTURE §18, hardware track H2–H3). The ESP32-S3 has no TypeScript, ~500 KB of internal RAM, 8 MB of PSRAM and a 240×240 round display. Her face was designed in the browser (`packages/character`, `apps/web-body`) and must look the same on the desk; the protocol must be followed exactly, with no TypeScript to lean on.

## Decision

- **A thin client in ESP-IDF 5.x, C.** The firmware (`firmware/desk-companion`) renders, hears, speaks and talks the Body Protocol. It never runs a model (§15). Wake word, provisioning and OTA come later (H4); the first voice path is push-to-talk, as the hardware doc planned.
- **One face, generated.** `packages/character`'s presets, neutral pose and spring tuning are emitted as C tables (`pnpm firmware:presets` → `components/core/rig_presets.c`); a test fails when they drift. The rig logic (springs with sub-steps, modes, blinks, saccades, breath, speech) is a line-for-line port. `Motion` is not ported: on the device the display is her clock case, so her body is never in view and the firmware declares no `animate` capability.
- **A portable core, tested on the host.** `components/core` (rig, rasterizer, face, base64, protocol codec) has no ESP-IDF dependency. `host/` builds it with a plain C compiler, runs it against `packages/protocol/fixtures`, and draws her pose sheet; CI does the same. Only the IDF glue (`main/`) needs the toolchain and the board.
- **Protocol contract fixtures** (§17): `packages/protocol/fixtures` holds one valid example of every message type and a set of messages the brain rejects, with the reason. The TypeScript codec and the C codec are both tested against the same files.
- **Audio as the protocol says.** Uplink 16 kHz PCM16 in ~1 s chunks (as the browser body sends); downlink Kokoro's 24 kHz PCM16, played gap-free from a PSRAM ring buffer with the mouth driven by amplitude and zero crossings, the same rule as the browser. Frames stay JSON with base64; the firmware reassembles fragmented frames into a PSRAM buffer sized for the protocol's limit.
- **Holding the button while she talks is a barge-in** (ADR-0010): playback stops and `event.interrupt` goes up before the microphone opens.
- **The dial window.** A watch-style window at 6 o'clock shows the local time, the countdown while a timer runs, or `OFF` when the brain is unreachable, in seven-segment digits. The browser body shows these outside the face; on the device there is no outside.
- **Software rendering, no LVGL.** A small anti-aliased RGB565 rasterizer (ellipses, thick curves, coverage-filled polygons, clip masks, shaded discs) draws her in a few milliseconds per feature; the full face at 240×240 renders in well under a frame at 30 fps on the host and is expected around 15–25 fps on the S3, with the SPI transfer (~25 ms at 40 MHz) as the floor. LVGL would add a dependency without drawing her any better.

## Consequences

- Verified on the host: all core tests pass and the pose sheet shows every affect, her modes, a running timer, ringing and offline, matching the browser body. The ESP-IDF build and the device bring-up remain to be done on hardware (H0–H1 first); any API drift in ESP-IDF 5.x will surface at the first `idf.py build`.
- The brain needs no changes for the device, apart from listening on the LAN (`HOST=0.0.0.0`). A body on the network with `TTS_PROVIDER=kokoro` and `STT_PROVIDER=local` gets her voice and her hearing.
- Still open for a device on the desk: authentication (§13.4), binary audio frames, quiet hours (§14), and the H4 list.

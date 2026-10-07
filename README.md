# Ms. Minutes

> **One Brain. Many Bodies.**
> A persistent AI companion that talks naturally and inhabits many bodies, starting with a tiny retro clock on the desk.

[![CI](https://github.com/thrishankkuntimaddi/MsMinutes/actions/workflows/ci.yml/badge.svg)](https://github.com/thrishankkuntimaddi/MsMinutes/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md), and key decisions are recorded in [docs/adr](docs/adr).

## Status

**v0.7.** Phases 1–6 are done: she talks (Claude or a local model), shows her mood on an animated face, speaks and hears with local neural voice and speech recognition, remembers you across restarts, and runs timers, reminders and the weather, speaking up when one fires. Turns are traced at `GET /api/turns`.

**Phase 7, the real device:** the ESP32-S3 firmware is written ([firmware/desk-companion](firmware/desk-companion/README.md)) and its portable core is tested here on every push. It is waiting for the parts on the [hardware list](docs/hardware/desk-companion.md).

## Layout

```
apps/brain          The brain: WebSocket gateway, body registry, event bus
apps/stub-body      A terminal body for exercising the protocol
apps/web-body       The browser body: her animated face, voice and microphone
packages/character  Her face as a parameter rig: presets, springs, idle life, lip-sync
packages/protocol   The Body Protocol: zod schemas, types, codec, JSON Schema
packages/persona    Who she is: persona.md becomes her system prompt
firmware/desk-companion  ESP32-S3 firmware: her face in C, push-to-talk, the Body Protocol
docs/adr            Architecture Decision Records
docs/hardware       Parts lists, wiring and bring-up for physical bodies
```

## Getting started

Requires Node 24 (see `.nvmrc`). pnpm is provided through corepack:

```sh
corepack enable        # once; puts `pnpm` on your PATH
pnpm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

No API key? Run her on a local model with [Ollama](https://ollama.com) instead. The model must support tool calling:

```sh
ollama pull qwen2.5:3b # once
ollama serve           # if it isn't already running
# in .env: LLM_PROVIDER=ollama (and optionally OLLAMA_MODEL=...)
```

Run the brain and talk to her from the terminal body:

```sh
pnpm dev:brain         # terminal 1: brain on ws://127.0.0.1:7700/ws
pnpm stub-body         # terminal 2: type to talk
```

```
you › Good morning
Ms. Minutes › [happy 0.5] Good morning, Alex! Coffee first, or straight into it?
```

Or meet her in the browser: she introduces herself, then you talk by mic or keyboard and she answers out loud.

```sh
pnpm dev:brain         # terminal 1
pnpm dev:web           # terminal 2: open http://localhost:5179
```

Her voice: set `TTS_PROVIDER=kokoro` in `.env` and the brain speaks with Kokoro, a local neural voice (~330 MB, downloaded on first run; pick another with `TTS_VOICE`, e.g. `af_bella`). Without it, the browser uses its own voices. Re-render the intro greeting with `pnpm --filter @ms-minutes/brain say "<text>" ../web-body/public/voice/greeting.wav`.

Talking hands-free: with `STT_PROVIDER=local`, the brain also hears you (Moonshine speech recognition on this machine, ~250 MB on first run). Click the mic once and just talk; she listens for when you start and stop, and you can talk over her to interrupt. Headphones help if your speakers echo into the mic. Without it, the mic button uses the browser's own recognition.

Her memory: with `MEMORY_DB=./data/memory` she remembers you across conversations and restarts, in an embedded Postgres + pgvector (PGlite) under `data/`. No database server needed; or point `MEMORY_DB` at a `postgres://` URL (`docker compose -f infra/docker-compose.yml up -d`). See and edit what she remembers under **Her memories** in the browser, or via `GET /api/memories`.

Her skills: ask her to set a timer ("tea, 4 minutes"), remind you of something ("remind me to call mom at 6:30"), or check the weather. Timers count down on her face and survive restarts; when one goes off, her bells ring and she tells you. Set `WEATHER_PLACE` in `.env` so "the weather" means where you are.

She can leave the TV: click **Come out** (or the screen, or ask her to come out) and she drops onto the desk and walks around the room while you talk; **Back in the TV** sends her home. What she says shows under the TV, never over her face.

Her poses and moves are on a check sheet at http://localhost:5179/poses.html.

Her personality lives in [packages/persona/persona.md](packages/persona/persona.md). Edit it and restart the brain.

## Scripts

| Script                  | What it does                                            |
| ----------------------- | ------------------------------------------------------- |
| `pnpm dev:brain`        | Run the brain with reload on change                     |
| `pnpm stub-body`        | Connect a terminal body to the brain                    |
| `pnpm dev:web`          | Serve the browser body (proxies `/ws` to the brain)     |
| `pnpm test`             | Run all tests                                           |
| `pnpm typecheck`        | Typecheck the whole monorepo                            |
| `pnpm lint`             | ESLint                                                  |
| `pnpm format`           | Prettier                                                |
| `pnpm check`            | Typecheck + lint + format check + tests (what CI runs)  |
| `pnpm schema:generate`  | Regenerate JSON Schema for non-TypeScript bodies        |
| `pnpm firmware:presets` | Regenerate the firmware's rig tables from `character`   |
| `pnpm firmware:check`   | Build and test the firmware core with the host compiler |

## Brain endpoints

| Endpoint          | Purpose                     |
| ----------------- | --------------------------- |
| `GET /health`     | Liveness + protocol version |
| `GET /api/bodies` | Currently connected bodies  |
| `WS /ws`          | Body Protocol               |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and send a change, and the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security problem? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Thrishank Kuntimaddi

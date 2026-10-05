# Ms. Minutes — Architecture

> **One Brain. Many Bodies.**
> A persistent AI identity that talks naturally with a human and inhabits many digital and physical bodies — starting with a tiny retro clock on the desk.

|              |                   |
| ------------ | ----------------- |
| Status       | v0.3 (Phases 2–4) |
| Last updated | 2026-10-05        |
| Owner        | Thrishank         |

---

## Table of Contents

1. [Purpose & Principles](#1-purpose--principles)
2. [The Core Reframe: The Protocol Is the Product](#2-the-core-reframe-the-protocol-is-the-product)
3. [Key Architectural Decisions](#3-key-architectural-decisions)
4. [Domain Model](#4-domain-model)
5. [System Overview](#5-system-overview)
6. [Body Protocol](#6-body-protocol)
7. [Brain Internals](#7-brain-internals)
8. [LLM Integration](#8-llm-integration)
9. [Character & Animation Engine](#9-character--animation-engine)
10. [Voice Pipeline](#10-voice-pipeline)
11. [Memory](#11-memory)
12. [Skills & Capabilities](#12-skills--capabilities)
13. [Safety & Permissions](#13-safety--permissions)
14. [Proactivity](#14-proactivity)
15. [Bodies](#15-bodies)
16. [Repository Layout & Tech Stack](#16-repository-layout--tech-stack)
17. [Observability & Quality](#17-observability--quality)
18. [Roadmap](#18-roadmap)
19. [Open Decisions](#19-open-decisions)
20. [Architecture Decision Records](#20-architecture-decision-records)

---

## 1. Purpose & Principles

Ms. Minutes is not a smart speaker and not a single device. It is **one persistent AI brain** with a single identity, memory and personality. Devices are **bodies** — clients that give the brain a way to perceive and act.

### Guiding principles

1. **Present, not callable.** The brain reacts to the world (events), not only to commands. It knows when to speak and when to stay quiet.
2. **The brain is not the body.** No device owns the AI. Every device is a replaceable client.
3. **AI decides, deterministic software executes.** The LLM chooses _what_ should happen; typed, tested code performs _how_. The LLM never drives motors, pixels or hardware directly.
4. **Abstract out, concrete in the body.** The brain emits abstract intent (affect, speech, capability calls). Each body renders it in its own way.
5. **Latency is a feature.** For a voice-first companion, response time is part of the personality.
6. **Safety and privacy are structural.** Permissions, risk tiers and user-visible memory are built in, not bolted on.
7. **Start as a modular monolith.** Clear module boundaries, one deployable. Split only when there is a measured reason.

---

## 2. The Core Reframe: The Protocol Is the Product

"One Brain, Many Bodies" is fundamentally a client–server system. The most important artifact is not the LLM integration — it is the **contract between the brain and any body**.

- If the contract is right, a desk clock, a phone, an RC car and a robot arm are all just clients that announce their capabilities.
- If the contract is wrong, the brain is rewritten for every new body.

Therefore the first deliverable is **`@ms-minutes/protocol`**: a versioned, typed message schema shared by every component.

---

## 3. Key Architectural Decisions

### 3.1 Persistent bidirectional connection from day one

A stateless `POST /api/chat` is insufficient for:

- streaming speech and audio,
- live animation directives while speaking,
- proactive speech (brain speaks first),
- multiple simultaneously connected bodies.

**Decision:** Bodies connect over **WebSocket**. REST is used only for administration and configuration (devices, memories, settings, permissions).

### 3.2 Events in → Decisions → Directives out

The brain's core loop is not request/response. It is:

```
Events in  ──►  Brain decides  ──►  Directives out
```

A user utterance is **one event type among many**: timer fired, device connected, user arrived home, presence detected, etc. Phase 1 implements only `user.utterance`, but the loop is shaped for proactivity from the start.

### 3.3 Expression is a capability

Emotion/animation is not a special hard-wired pipe. A body declares capabilities:

- Desk companion: `speak`, `listen`, `express`, `display`
- RC car: `move`, `turn`, `stop`, `camera`
- Robot arm: `move`, `grab`, `rotate`, `hold`

**Body capabilities are exposed to the LLM as tools.** Expressing "happy" and driving a car forward are the same kind of operation: a capability call on a body. This unifies Skills, Devices and Animation into one model.

---

## 4. Domain Model

| Concept          | Definition                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Persona**      | Ms. Minutes herself: name, personality, voice, values, boundaries. Exactly one.                                               |
| **User**         | A human the persona knows. Single-user initially; `userId` is on everything.                                                  |
| **Body**         | A connected client device: `id`, `type`, `capabilities`, `status`, `permissions`.                                             |
| **Capability**   | Something a body can do, described by a name and a JSON schema for arguments.                                                 |
| **Presence**     | Which bodies are online, and which body is currently _active_ (where she "is").                                               |
| **Conversation** | One continuous thread with a user that **spans bodies**. This is what "same brain" means in practice.                         |
| **Turn**         | One cycle of event → reasoning → directives. Fully logged and traceable.                                                      |
| **Event**        | Any input reaching the brain (utterance, timer, sensor, device lifecycle, skill result).                                      |
| **Directive**    | Any output from the brain (speech, expression, state change, capability call).                                                |
| **Affect**       | The persona's emotional state: `label` + `intensity` (later `valence`/`arousal`). Persists across turns and decays over time. |
| **Skill**        | A server-side tool (timer, weather, music…) with a schema and a deterministic executor.                                       |
| **Memory**       | Long-term facts, preferences, episodes and summaries.                                                                         |
| **Permission**   | A grant allowing a user/context to trigger a capability or skill at a given risk tier.                                        |

---

## 5. System Overview

```
┌──────────────────────────── BRAIN (Node.js + TypeScript) ──────────────────────────┐
│                                                                                    │
│  Gateway (WebSocket + REST) ── auth · body registry · presence                     │
│        │                                                                           │
│        ▼                                                                           │
│  Event Bus (in-process) ◄── skill results · timers · sensors · device lifecycle    │
│        │                                                                           │
│        ▼                                                                           │
│  Orchestrator ── builds context: persona + affect + memory + online bodies         │
│        │                                                                           │
│        ▼                                                                           │
│  LLM Adapter (streaming, tool calling)                                             │
│        │  tool calls                                                               │
│        ▼                                                                           │
│  Policy / Safety Gate ── permissions · risk tier · confirmation                    │
│        │                                                                           │
│        ├──► Skill Executors (timer, weather, music…)  — deterministic              │
│        └──► Body Router ──► capability.call on the appropriate body                │
│                                                                                    │
│  Voice: STT adapter · TTS adapter   │   Memory: Postgres + pgvector   │  Tracing    │
└────────────────────────────────────────────────────────────────────────────────────┘
                     ▲                         ▲                         ▲
                     │ WebSocket               │ WebSocket               │ WebSocket
              ┌──────┴──────┐           ┌──────┴──────┐           ┌──────┴──────┐
              │ Desk Body   │           │ Mobile Body │           │ Future      │
              │ (web→ESP32) │           │             │           │ Arm / Car   │
              └─────────────┘           └─────────────┘           └─────────────┘
```

Every box inside the brain is a **module with an explicit interface**, not a separate service.

---

## 6. Body Protocol

### 6.1 Transport

- WebSocket, JSON text frames for control messages.
- Binary frames (or base64 in JSON initially) for audio chunks.
- Protocol version negotiated in `hello`.

### 6.2 Envelope

Every message shares one envelope:

```ts
type Envelope<T extends string, P> = {
  v: 1; // protocol version
  id: string; // message uuid
  type: T; // message type
  bodyId: string; // sender or target body
  ts: number; // unix ms
  replyTo?: string; // correlates responses
  payload: P;
};
```

### 6.3 Body → Brain

| Type                   | Payload                                              | Notes                                  |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- |
| `hello`                | `{ bodyType, firmware, capabilities: Capability[] }` | First message after connect            |
| `heartbeat`            | `{}`                                                 | Liveness                               |
| `event.utterance.text` | `{ text }`                                           | Typed input (dev console, mobile)      |
| `event.audio.chunk`    | `{ seq, codec, sampleRate, data }`                   | Streamed mic audio after wake word/VAD |
| `event.audio.end`      | `{}`                                                 | End of user speech                     |
| `event.interrupt`      | `{}`                                                 | Barge-in: user started speaking        |
| `event.sensor`         | `{ kind, data }`                                     | Presence, button, etc.                 |
| `capability.result`    | `{ callId, ok, data?, error? }`                      | Result of a capability call            |

### 6.4 Brain → Body

| Type                 | Payload                                                                               | Notes                            |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `welcome`            | `{ sessionId, persona, permissions, heartbeatIntervalMs }`                            | Response to `hello`              |
| `state.set`          | `{ mode: "idle" \| "listening" \| "thinking" \| "speaking" \| "timer_running" \| … }` | High-level body state            |
| `expression.set`     | `{ affect, intensity, transitionMs, blend? }`                                         | Abstract affect; body renders    |
| `speech.text.delta`  | `{ turnId, text }`                                                                    | Streamed text (captions/console) |
| `speech.audio.chunk` | `{ turnId, seq, codec, sampleRate, data }`                                            | TTS audio                        |
| `speech.marks`       | `{ turnId, marks: { t, kind, value }[] }`                                             | Optional timing (visemes/words)  |
| `speech.end`         | `{ turnId }`                                                                          | Speech finished                  |
| `speech.cancel`      | `{ turnId }`                                                                          | Stop playback (barge-in)         |
| `capability.call`    | `{ callId, name, args }`                                                              | Ask body to perform a capability |
| `error`              | `{ code, message, fatal }`                                                            | Fatal errors close the socket    |

### 6.5 Capability declaration

```ts
type Capability = {
  name: string; // e.g. "express", "move", "display.mode"
  description?: string; // used in LLM tool description
  schema?: JSONSchema; // argument schema
  riskTier: 0 | 1 | 2 | 3; // body's self-declared minimum tier
};
```

Example (desk companion):

```json
{
  "type": "hello",
  "payload": {
    "bodyType": "desk_companion",
    "firmware": "0.1.0",
    "capabilities": [
      { "name": "speak", "riskTier": 0 },
      { "name": "listen", "riskTier": 2 },
      { "name": "express", "riskTier": 0 },
      { "name": "display.mode", "riskTier": 0 }
    ]
  }
}
```

### 6.6 Versioning rules

- Schemas live in `packages/protocol` (zod), are the single source of truth, and generate JSON Schema for non-TS clients (ESP32 firmware, mobile).
- The envelope's `v` is the protocol version. A mismatch is rejected with `unsupported_version`.
- Additive changes only within a version. After `hello`, an unknown or malformed message gets a non-fatal `invalid_message` error. Bodies ignore brain messages they don't recognise.
- Run `pnpm schema:generate` to regenerate `packages/protocol/schema/*.json` after changing schemas.

### 6.7 Connection lifecycle

1. Body connects to `ws://<brain>/ws` and must send `hello` within `HELLO_TIMEOUT_MS` (default 10 s).
2. Brain replies `welcome` (with `replyTo` = hello id) and registers the body.
3. Body sends `heartbeat` (or any message) at least every `heartbeatIntervalMs`. Silence for 3× that interval disconnects it.
4. A new connection with the same `bodyId` replaces the old one.
5. Every message after `hello` must carry the same `bodyId`.

| Close code | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| 1000       | Normal close                                              |
| 4000       | Protocol error (bad first message, invalid JSON, version) |
| 4001       | No `hello` in time                                        |
| 4002       | Replaced by a newer connection with the same `bodyId`     |
| 4003       | Heartbeat timeout                                         |

---

## 7. Brain Internals

### 7.1 Modules

| Module         | Responsibility                                               |
| -------------- | ------------------------------------------------------------ |
| `gateway`      | WebSocket/REST server, auth, connection lifecycle            |
| `bodies`       | Body registry, capabilities, presence, active-body selection |
| `events`       | In-process typed event bus                                   |
| `orchestrator` | Turn lifecycle: context assembly → LLM → tools → directives  |
| `llm`          | Provider adapter: streaming, tool calling                    |
| `voice`        | STT and TTS adapters, sentence chunking                      |
| `affect`       | Persistent emotional state, decay, transitions               |
| `skills`       | Skill registry and executors                                 |
| `policy`       | Permissions, risk tiers, confirmations                       |
| `memory`       | Storage, extraction, retrieval                               |
| `persona`      | System prompt, personality spec, voice config                |
| `tracing`      | Per-turn traces and latency metrics                          |

### 7.2 Turn lifecycle

```
1. Event arrives (e.g. user.utterance)
2. Orchestrator opens a Turn (turnId, trace span)
3. Body(ies) → state.set: thinking
4. Context assembled:
     persona prompt
   + current affect
   + relevant memories
   + conversation window / summary
   + online bodies & capabilities (as tools)
   + skills (as tools)
5. LLM streams:
     text deltas  ──► sentence chunker ──► TTS ──► speech.audio.chunk
     tool calls   ──► policy gate ──► skill executor | body capability.call
6. Directives routed to the active body (or target body)
7. Turn closed; trace persisted; memory extraction queued (async)
```

### 7.3 Active-body routing

- Responses go to the body that produced the triggering event.
- Proactive output goes to the body where the user was most recently present.
- Explicit targeting ("make the car turn left") is resolved via capabilities.

---

## 8. LLM Integration

### 8.1 Output strategy

Do **not** ask the model for a single JSON blob containing text + emotion; it is brittle and incompatible with streaming. Instead:

- **Spoken words** → normal streamed assistant text.
- **Expression** → `set_expression({ affect, intensity })` tool call.
- **Skills/actions** → tool calls (`timer_start`, `weather_get`, `desk_display_mode`, …).

The persona prompt instructs her to call `set_expression` at the start of a reply and whenever her mood shifts.

### 8.2 Model allocation

| Job                                                    | Model class                                          |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Main conversation loop                                 | Strong conversational model (e.g. Claude Sonnet 5.5) |
| Memory extraction, summarization, interruption scoring | Small fast model (e.g. Claude Haiku 4.5)             |

### 8.3 Adapter boundary

LLM, STT and TTS each sit behind a thin interface so providers can be swapped. Avoid building a generic framework on top.

```ts
interface LLM {
  stream(req: LLMRequest): AsyncIterable<LLMEvent>; // text_delta | tool_call | done
}
interface STT {
  transcribe(stream: AsyncIterable<AudioChunk>): AsyncIterable<Transcript>;
}
interface TTS {
  synthesize(text: string, voice: VoiceConfig): AsyncIterable<AudioChunk>;
}
```

---

## 9. Character & Animation Engine

### 9.1 Principle

The LLM never generates frames. The brain sends **abstract affect**; **each body renders it**.

```
AI → Affect (label + intensity) → Animation parameters → Character
```

### 9.2 Parameter rig

The character is a small set of numeric parameters (all normalized):

| Parameter                | Meaning                                     |
| ------------------------ | ------------------------------------------- |
| `eyeOpen`                | 0 closed → 1 wide                           |
| `pupilX`, `pupilY`       | Gaze direction                              |
| `browAngle`              | Inner-brow tilt (worry ↔ anger)             |
| `browHeight`             | Surprise ↔ frown                            |
| `mouthCurve`             | Frown ↔ smile                               |
| `mouthOpen`              | Speech/surprise                             |
| `hourHand`, `minuteHand` | Clock-hand angles (expressive or real time) |
| `armL`, `armR`           | Small limb poses                            |
| `bounce`                 | Body squash/bob                             |

### 9.3 Layers

```
Layer 4  Action    timer mode, searching, music bounce
Layer 3  Speech    mouthOpen from audio amplitude / visemes
Layer 2  Emotion   preset targets (happy, sad, curious…) × intensity
Layer 1  Idle      blinks, eye saccades, breathing, clock ticking
                     ↓ blend + ease (springs / lerp)
               parameter vector → renderer
```

- An emotion is a **preset of target values** (JSON).
- Blending emotions = weighted interpolation of presets → procedural expressions for free.
- Affect set: `neutral, happy, sad, angry, surprised, curious, confused, sleepy, excited, concerned, laughing, thinking, playful, shy, proud`. Each preset also sets arm poses and glove shapes (open, fist, point, thumb).
- Layer 4 actions (`walk, run, jump, turn_around, spin, sit, stand, dance, wave, bow, come_closer, step_back, peek`) live in `packages/character` (`Motion`); bodies list the ones they support in an `animate` capability (ADR-0008).
- `listening` and `speaking` are **modes** (`state.set`), not emotions.

### 9.4 Portability

- `packages/character` is pure, renderer-agnostic logic + JSON presets.
- Web renderer: Canvas 2D at **240×240** (matches round GC9A01-class displays).
- ESP32 renderer: LVGL / direct framebuffer; rig logic ported to C++ (small, data-driven).

---

## 10. Voice Pipeline

### 10.1 Flow

```
Mic → Wake word → VAD → streaming STT → LLM (streaming)
                                           ├─► sentence chunker → TTS → speaker
                                           └─► expression / state directives
```

### 10.2 Rules

- **Stream every stage.** Never wait for the full LLM reply before starting TTS.
- **Latency budget:** target ≤ 1.5 s from end of user speech to first audio.

  | Stage                       | Budget  |
  | --------------------------- | ------- |
  | VAD end-of-speech detection | ~300 ms |
  | STT finalization            | ~200 ms |
  | LLM first sentence          | ~500 ms |
  | TTS first audio             | ~300 ms |
  | Network / playback          | ~200 ms |

- **Barge-in:** if the user speaks during playback, body sends `event.interrupt`; brain sends `speech.cancel` and aborts the turn.
- **Mouth sync:** start with amplitude (RMS of playback buffer) — identical on web and ESP32. Upgrade to visemes if the TTS provider supplies them.
- **Wake word + VAD run on the body.** The brain never receives an always-on audio stream (privacy, bandwidth, trust).

### 10.3 Audio formats

- Uplink: 16 kHz mono PCM16 (Opus later).
- Downlink: provider-native (MP3/PCM) on web; PCM16 for ESP32 I²S.

---

## 11. Memory

### 11.1 Tiers

| Tier      | Contents                                          | Storage                  |
| --------- | ------------------------------------------------- | ------------------------ |
| Working   | Current conversation window, affect               | In-process + LLM context |
| Episodic  | Every turn and event, with traces                 | Postgres                 |
| Semantic  | Facts & preferences ("likes lo-fi", "wakes at 7") | Postgres + pgvector      |
| Summaries | Rolling daily / conversation summaries            | Postgres                 |

### 11.2 Flow

- **Write after a turn:** an async extractor (small model) proposes new/updated facts.
- **Read before a turn:** retrieve by semantic relevance + recency + importance.
- **User control:** all memories are viewable, editable and deletable via REST/UI. This is a core trust feature.

### 11.3 Initial schema (sketch)

```
users(id, name, created_at)
bodies(id, user_id, type, name, capabilities jsonb, last_seen_at)
conversations(id, user_id, started_at, summary)
turns(id, conversation_id, body_id, trigger_event jsonb, trace jsonb, created_at)
messages(id, turn_id, role, content, created_at)
memories(id, user_id, kind, content, embedding vector, importance, source_turn_id, created_at, updated_at)
reminders(id, user_id, due_at, payload jsonb, status)
permissions(id, user_id, subject, capability, risk_tier, granted_at, expires_at)
```

---

## 12. Skills & Capabilities

### 12.1 Skill interface

```ts
interface Skill<A, R> {
  name: string; // "timer.start"
  description: string; // shown to the LLM
  schema: ZodSchema<A>; // argument validation
  riskTier: 0 | 1 | 2 | 3;
  execute(args: A, ctx: SkillContext): Promise<R>;
}
```

- Skills are registered at startup; capabilities are registered dynamically by bodies in `hello`.
- Both are presented to the LLM as tools; both pass through the policy gate.
- Long-running skills (timers, music) emit events back onto the bus when they change state.

### 12.2 Example — timer

```
"Set a timer for 20 minutes."
  → LLM: timer.start({ durationSec: 1200 })
  → policy: tier 1, allowed
  → executor schedules timer; returns { timerId, endsAt }
  → body: state.set(timer_running) + display.mode(timer, endsAt)
  → (20 min later) event: timer.fired → new Turn → she speaks
```

The timer firing is the **first proactive behavior** the system supports.

### 12.3 Planned skills

Timer · Alarm · Reminder · Weather · Web search · Calendar · Music · Smart home · Device control.

---

## 13. Safety & Permissions

### 13.1 Request path

```
User → Authentication → Authorization → Brain → Policy gate (permission + risk tier)
     → Safety validation → Body/Skill → Body-side safety controller → Hardware
```

### 13.2 Risk tiers

| Tier                        | Examples                                   | Policy                                      |
| --------------------------- | ------------------------------------------ | ------------------------------------------- |
| 0 — Info                    | Weather, time, expression                  | Automatic                                   |
| 1 — Reversible              | Timer, music, lights                       | Automatic if granted                        |
| 2 — Sensitive               | Camera view, microphone access, door state | Explicit grant, always logged               |
| 3 — Physical / irreversible | Arm motion, car driving, locks             | Confirmation + validator + body-side limits |

### 13.3 Body-side safety (mandatory for physical bodies)

- Deterministic controllers own motor control; the brain sends **high-level intents only**.
- **Watchdog:** if the brain connection drops or heartbeats stop, motion halts.
- Hardware emergency stop.
- Bodies enforce their own limits (speed, force, workspace bounds) regardless of what the brain requests.

### 13.4 Authentication

- Each body has a device credential (token issued at pairing).
- Users authenticate on mobile/web; device pairing requires an authenticated user.

---

## 14. Proactivity

Proactivity is a pipeline over events, not a timer that makes her chatty:

```
Observe → Understand context → Determine significance → Interruption policy → Speak OR stay silent
```

- **Significance scoring** by the small model, with deterministic rules first (timers, reminders always fire).
- **Interruption policy:** quiet hours, focus mode, cool-down between unprompted remarks, per-user tolerance setting.
- Default is **silence**. Unprompted speech must clear a threshold.

---

## 15. Bodies

| Body           | Phase | Role                                  | Notes                                                                                     |
| -------------- | ----- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Web dev body   | 1–3   | Console + canvas character            | The reference client for the protocol                                                     |
| Desk companion | H0–H4 | Primary physical body (current focus) | ESP32-S3, ~1.28" round display, I²S mic (e.g. INMP441), I²S amp (e.g. MAX98357A), battery |
| Mobile app     | 8     | Portable body + control center        | Conversation, memories, devices, privacy settings                                         |
| Camera         | 9     | Perception body                       | Presence/context events only; raw video stays local where possible                        |
| Robot arm      | 10    | Physical actor                        | Tier 3, local controller + watchdog                                                       |
| RC car         | 10    | Mobile physical actor                 | Tier 3, local collision avoidance + watchdog                                              |
| Smart home     | 10    | Environment actor                     | Via a bridge (e.g. Home Assistant) as a body                                              |

The ESP32 is a **thin client**: wake word, VAD, audio I/O, rig rendering, protocol. It never runs the LLM.

Parts list, wiring, power budget and firmware stack for the desk companion: [docs/hardware/desk-companion.md](docs/hardware/desk-companion.md).

---

## 16. Repository Layout & Tech Stack

```
ms-minutes/
├─ ARCHITECTURE.md
├─ apps/
│  ├─ brain/              # Fastify + ws; orchestrator, skills, voice, memory
│  ├─ stub-body/          # Terminal body for exercising the protocol
│  └─ web-body/           # Vite + TS; dev console + canvas character
├─ packages/
│  ├─ protocol/           # zod schemas, types, generated JSON Schema
│  ├─ character/          # rig, presets, blending (renderer-agnostic)
│  └─ persona/            # system prompt, personality spec, voice config
├─ firmware/
│  └─ desk-companion/    # ESP32-S3 (ESP-IDF + LVGL), hardware track H1–H4
├─ docs/
│  ├─ adr/                # Architecture Decision Records
│  └─ hardware/           # Bills of materials, wiring, bring-up per body
└─ infra/
   └─ docker-compose.yml  # Postgres + pgvector
```

| Concern          | Choice                |
| ---------------- | --------------------- |
| Language         | TypeScript (strict)   |
| Runtime          | Node.js LTS           |
| Monorepo         | pnpm workspaces       |
| HTTP / WS        | Fastify + `ws`        |
| Validation       | zod                   |
| Database         | PostgreSQL + pgvector |
| ORM / migrations | Drizzle               |
| Web body         | Vite + Canvas 2D      |
| Tests            | Vitest                |
| Lint / format    | ESLint + Prettier     |
| CI               | GitHub Actions        |
| Commits          | Conventional Commits  |

---

## 17. Observability & Quality

- **Turn traces from Phase 1:** event → context size → LLM calls → tool calls → directives, with per-stage latency. Persisted with each turn.
- **Structured logging** (pino) with `turnId`, `bodyId`, `conversationId`.
- **Latency dashboard** for the voice budget (Phase 3+).
- **Personality evals:** scripted conversations checked for staying in character, sensible affect choices, appropriate silence and correct tool use. Run in CI against prompt changes.
- **Protocol contract tests:** every body implementation is tested against `packages/protocol` fixtures.

---

## 18. Roadmap

**Current focus: the brain + the desk companion.** Mobile, vision, and the other bodies come after the desk companion works end to end. The work runs as two parallel tracks that meet at Phase 7.

### 18.1 Software track (brain)

| Phase                           | Deliverable                                                                | Done when…                                                                |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **0 — Architecture**            | Repo, this document, ADRs, `protocol` package, persona spec                | `hello` / `welcome` handshake works between brain and a stub body         |
| **1 — Brain**                   | WS gateway, event loop, streaming LLM, `set_expression` tool, turn tracing | Typing in the web console yields a streamed reply + affect directive      |
| **2 + 4 — Character & Emotion** | Canvas rig, layered blending, presets, state modes                         | Replies visibly change her face; idle life (blinks, gaze) runs on its own |
| **3 — Voice**                   | Browser mic, VAD, streaming STT/TTS, barge-in, amplitude mouth sync        | Spoken round trip ≤ ~1.5 s and interruptible                              |
| **5 — Memory**                  | Postgres, extraction, retrieval, memory viewer                             | She remembers a preference the next day                                   |
| **6 — Skills**                  | Skill framework, timer/reminder/weather, risk tiers                        | Timer runs on the clock face; she speaks when it fires                    |
| **7 — Real Device**             | Hardware track H0–H4 (below) meets the brain                               | Same brain, now physically on the desk                                    |
| **8 — Mobile**                  | Mobile body, presence, cross-body handoff                                  | Conversation started at the desk continues on the phone                   |
| **9 — Vision & Proactivity**    | Camera body, significance scoring, interruption policy, privacy controls   | She speaks up rarely and appropriately                                    |
| **10 — Multiple Bodies**        | Arm, car, home bridge; tier-3 safety                                       | A new body joins via `hello` with no brain changes                        |

### 18.2 Hardware track (desk companion), starting now

| Step                    | Deliverable                                                                        | Done when…                                        | Needs from brain |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------- |
| **H0 — Parts**          | Order the BOM ([docs/hardware/desk-companion.md](docs/hardware/desk-companion.md)) | All parts on the desk                             | —                |
| **H1 — Bring-up**       | Board, display, speaker, mic each tested on their own (ESP-IDF)                    | Static face drawn; tone plays; mic loopback works | —                |
| **H2 — Connected body** | Firmware speaks the Body Protocol; renders `expression.set` with the ported rig    | Brain changes the face on the real screen         | Phase 0 ✓, 2     |
| **H3 — Voice body**     | Push-to-talk audio up, TTS audio down, amplitude mouth sync                        | You talk to her on the device                     | Phase 1, 3       |
| **H4 — Standalone**     | Battery, Wi-Fi provisioning, OTA, wake word, enclosure                             | She lives on the desk unplugged                   | —                |

The browser body (Phases 2–3) stays the fast place to iterate: the face and voice are designed there at 240×240, then ported to the device in H2–H3.

---

## 19. Open Decisions

| #   | Question                  | Options                 | Notes                                                               |
| --- | ------------------------- | ----------------------- | ------------------------------------------------------------------- |
| 1   | Where does the brain run? | Cloud VPS / home server | Home server favours privacy (cameras); affects auth & remote access |
| 2   | LLM provider              | Claude / other          | Main + small model split either way                                 |
| 3   | STT / TTS providers       | Cloud streaming / local | Cloud first for latency & quality; local as privacy mode later      |
| 4   | Persona specification     | —                       | One page: personality, speaking style, voice, things she never does |
| 5   | Single-user or household  | Single first            | `userId` everywhere regardless                                      |

---

## 20. Architecture Decision Records

ADRs live in `docs/adr/` using the format: _Context → Decision → Consequences_.

| ADR  | Title                                                              | Status   |
| ---- | ------------------------------------------------------------------ | -------- |
| 0001 | WebSocket body protocol with shared typed envelope                 | Accepted |
| 0002 | Events-in / directives-out brain loop                              | Accepted |
| 0003 | Expression as a body capability; capabilities exposed as LLM tools | Accepted |
| 0004 | Modular monolith in a pnpm TypeScript monorepo                     | Accepted |
| 0005 | Spoken text streamed; structured outputs via tool calls            | Accepted |
| 0006 | Risk-tiered policy gate; body-side safety for physical bodies      | Accepted |
| 0007 | Local development model through an Ollama adapter                  | Accepted |
| 0008 | Inline stage tags for moods and body actions                       | Accepted |
| 0009 | Neural TTS in the brain, streamed as audio                         | Accepted |

---

_The project is not fundamentally about an ESP32, a tiny screen, or an LLM. It is about a persistent AI brain that communicates naturally and inhabits many bodies. This document is the path from the tiny clock to that architecture._

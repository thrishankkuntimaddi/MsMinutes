# Ms. Minutes Companion: Detailed Plan

|              |                                                     |
| ------------ | --------------------------------------------------- |
| Status       | Draft, awaiting decisions (section 6)               |
| Date         | 2026-10-12                                          |
| Scope        | 3D body, desktop companion, tools, physical devices |
| Next step    | Answer section 6, then start M0 step 1              |
| Related docs | [ARCHITECTURE.md](../ARCHITECTURE.md), [adr/](adr)  |

Nothing in this plan is implemented yet. It was written after reading the whole codebase (typecheck clean, 136 tests passing at the time).

---

## 1. Where the project is today

| Piece                                                                                               | State                      |
| --------------------------------------------------------------------------------------------------- | -------------------------- |
| Brain: gateway, orchestrator, Claude or Ollama, `[mood]`/`[action]` stage tags, turn traces         | Works                      |
| Body Protocol: versioned, zod schemas, JSON Schema, fixtures                                        | Works                      |
| Character rig: 25 parameters, springs, 15 moods, blinks, gaze, breathing, lip-sync, 13 body actions | Works                      |
| 2D renderer (TV stage and room stage)                                                               | Works                      |
| Voice: Kokoro TTS, Moonshine STT, browser VAD, barge-in (talking over her stops her)                | Works                      |
| Memory (PGlite + pgvector) with the case-file viewer                                                | Works                      |
| Skills: timers, reminders, weather, risk-tiered policy gate                                         | Works                      |
| ESP32 firmware                                                                                      | Written, waiting for parts |
| 3D body, desktop shell, desktop tools, arm and car                                                  | Not started                |

### The event contract already exists

The `CharacterEvent` contract from the original outline is already covered by the Body Protocol. Extend it instead of building a second event system.

| Outline `CharacterEvent`             | Existing protocol message                                       |
| ------------------------------------ | --------------------------------------------------------------- |
| `speech.started` / `speech.ended`    | `speech.audio.chunk` … `speech.end`                             |
| `listening.changed`                  | `state.set { mode: "listening" }`                               |
| `acting.intent`                      | `expression.set` plus inline tags like `[happy 0.6]` `[wave]`   |
| `action.completed` / `action.failed` | `capability.result` (exists, but not used correctly; see gap 1) |

### The three flows

1. **User → brain:** mic → VAD in the browser → `event.audio.chunk` × N, then `event.audio.end` → `apps/brain/src/modules/voice/hearing.ts` (Moonshine) → `transcript` → `orchestrator.enqueue`. Typed input arrives as `event.utterance.text`.
2. **Brain → voice:** LLM stream → `TagFilter` strips the tags → sentence chunker → Kokoro → `speech.audio.chunk` + `speech.marks` → `apps/web-body/src/audio-voice.ts` plays the audio, and the marks drive the mouth shapes.
3. **Brain → character:** `state.set` / `expression.set` / `capability.call animate` → the message switch in `apps/web-body/src/intro.ts` → `CharacterRig` → `rig.update(dt)` → `RigFrame` → `ClockRenderer.draw()`.

### Gaps found

1. **Actions are fire-and-forget.** The brain sends `capability.call` and never waits for a reply (`apps/brain/src/modules/orchestrator/orchestrator.ts:451`). The web body replies `ok: true` as soon as it accepts an action (`apps/web-body/src/intro.ts:271`), not when the action finishes. Until this is fixed she can't honestly say something is done.
2. **No clean place to plug in a second renderer.** `intro.ts` is 800 lines that call the renderer directly.
3. **Arm and leg geometry lives inside the 2D renderer** (`renderer.ts` `#arm`), so a 3D renderer can't reuse it.
4. **No upper-body gesture system.** Only `wave` exists, hard-coded in `packages/character/src/rig.ts`.
5. **Motion actions have no IDs, no "finished" events and no interruption rules.**
6. **Body capabilities aren't LLM tools.** Only `animate` is reachable, through tags. Desktop tools need a path through the policy gate.

---

## 2. The big decision: her 3D body without Blender

**Recommendation: build her 3D body in code with Three.js, with no Blender at all.**

Her design is made of simple shapes:

- **Clock case:** a short cylinder. The 2D renderer already uses these dimensions: radius 100, 24 thick.
- **Arms and legs:** rubber hoses, which are just a tube along a curve. `renderer.ts` already computes shoulder → elbow → hand.
- **Gloves, sneakers, bells, clock hands:** spheres, capsules and rounded boxes.
- **Face:** the existing 2D face, drawn every frame onto a texture on the front of the case.

Why this fits:

- **No modelling and no rigging.** Rubber-hose limbs have no elbows, so there's no skeleton. A limb is a curve from shoulder to hand.
- **Reaching for things is free.** Put the hand point on the teacup and the hose bends to reach it. With a skeleton you'd need inverse kinematics.
- **Everything already tuned keeps working.** The same `RigFrame` drives 2D and 3D: all 15 moods, blinks, lip-sync, walking, jumping and the tests. The ESP32 face stays in sync because its tables are generated from the same package.
- **3D adds what 2D can't:** a real turn that shows her back, lighting, depth, and holding objects. Her face stays hand-drawn 2D, which is how she looks in the show anyway.
- **The cartoon look comes from settings:** toon shading (three light steps), an ink outline and a soft contact shadow.

| Option                          | Verdict                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| **Code-built 3D (Three.js)**    | **Recommended**                                                                               |
| VRoid Studio + Mixamo           | Needs no design skill, but it makes anime humans, not a clock. It would lose her and the rig. |
| Fan model from Sketchfab        | Licensing problems (Marvel fan art), and it still needs rigging in Blender.                   |
| AI 3D generators (Meshy, Tripo) | Static meshes with no face controls. Fine for props only.                                     |
| Stay 2D                         | A valid fallback. The 2D renderer stays either way.                                           |

- **Props** (teacup, TV, chair) can come from free CC0 packs: Kenney, Quaternius, Poly Pizza. Props don't bend, so they need no rigging.
- **New moves without Blender:** a "Pose Studio" page, grown from `poses.html`. It would have sliders for each rig parameter, draggable hand targets and a keyframe timeline, and save clips as JSON.
- **Licensing:** Miss Minutes is Marvel/Disney's character and the repo is public. That's fine as a personal fan project, but if it's ever released she'd need an original look.

---

## 3. Revised roadmap

| #      | Milestone              | From the outline        | Rough size              | Done when                                                                                                 |
| ------ | ---------------------- | ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| **M0** | Foundation and seams   | Phase 0                 | 3–4 days                | Actions report when they really finish; 2D renderer runs behind an interface; Wayland test gives go/no-go |
| **M1** | 3D body                | Phase 1                 | 1–2 weeks               | `?view=3d` shows her full body, moods match the 2D sheet, 60 fps measured                                 |
| **M2** | Feels alive            | Phase 2                 | 2 weeks                 | Listens, speaks, explains with her hands, nods, shrugs; nothing snaps or gets stuck                       |
| **M3** | Desktop home           | Phase 4 (shell part)    | 2 weeks                 | Lives in a transparent window on the desktop, walks along the taskbar, doesn't block clicks               |
| **M4** | Acting and personality | Phase 3                 | 1–2 weeks               | Bad news gets stillness and a slower voice, not just a sad face                                           |
| **M5** | Honest tools           | Phase 4 tools + Phase 6 | 2–3 weeks               | The "interview notes" request works end to end, and failures are reported honestly                        |
| **M6** | Physical acting        | Phase 5                 | 3–4 weeks, then ongoing | Tea sequence runs reliably and can be interrupted cleanly                                                 |
| **M7** | Arm and RC car         | Phase 7                 | Separate track          | Simulated devices first, then real hardware with an e-stop                                                |
| **M8** | Hardening              | Phase 8                 | Ongoing                 | Added to every milestone, with a long soak test at the end                                                |

Why the order changed:

- **The biggest unknown gets tested first.** The desktop is KDE Plasma 6.7 on Wayland, and Wayland doesn't let apps place their own windows. That decides whether she can walk across the screen, so it gets a 2-day test in M0 instead of a surprise in week 6.
- **Desktop before personality tuning.** Once she's on the desktop all day, it becomes obvious what feels off. Tuning her acting in a browser tab is guesswork.
- **Useful before charming.** Tools (M5) come before tea-drinking (M6), because M6 can grow forever.

---

## 4. Milestone details

### M0: Foundation and seams (3–4 days)

1. **Action lifecycle** in `packages/character/src/motion.ts`: each action gets an ID and ends as `completed`, `interrupted` or `failed`. Each action has an interruption rule: walk, peek and dance can be interrupted; a jump in mid-air and sit/stand transitions finish first.
2. **Real completion:** the web body sends `capability.result` when the action ends. Error codes: `interrupted`, `unsupported`, `busy`, `timeout`.
3. **Brain `CapabilityRouter`** (new, in `apps/brain/src/modules/bodies/`): `call(bodyId, name, args, {timeoutMs, signal})` returns a promise matched by `callId`. If the body disconnects, all its pending calls fail.
4. **Renderer seam:**

   ```
   BrainLink ─► Director ─► CharacterRig ─► RigFrame ─► CharacterView
                 └─ action lifecycle, state             ├─ Canvas2DView (today's renderer)
                                                        └─ ToonView (Three.js, M1)
   ```

   After this, `intro.ts` keeps only the intro sequence and the UI.

5. **Shared limb geometry:** move it into `packages/character/src/pose.ts`, with tests proving the 2D output doesn't change.
6. **`docs/flows.md`:** the three flows from section 1, with file references.
7. **Desktop test (throwaway code):** a bare Electron window on the Wayland session. It must be transparent, frameless and always on top, let clicks through outside her, and move smoothly at 60 fps. Try both native Wayland and XWayland, then write down go/no-go.

**Tests:** router (resolves, times out, fails on disconnect), motion completion and interruption, Director dispatch with a fake view. The existing tests stay green.

**Done when:** a `[jump]` in a reply shows its result in the brain log only after she lands, the 2D view looks unchanged, and the desktop decision is written down.

### M1: Her 3D body (1–2 weeks)

1. **Three.js** (pinned version) added to `apps/web-body`; new code in `apps/web-body/src/views/toon/`.
2. **FacePainter:** extract the face drawing from `renderer.ts` (eyes, brows, mouth, cheeks, tear, ticks, countdown, back) into something that draws onto any canvas. The 2D renderer keeps using it; 3D draws it onto a 512×512 texture on the front of the case.
3. **Body parts:**
   - case with a gold rim
   - hose limbs, updated every frame from `pose.ts`
   - four glove poses: open, fist, point, thumb
   - sneakers and bells
   - clock hands as thin meshes just above the face
4. **Frame mapping:** `RigFrame` drives the scene. `yaw` becomes a real rotation, `lean` and tilt pivot at her feet, `squash` keeps her volume, `crouch` and `bounce` become offsets, and `ring` shakes the bells.
5. **Look:** toon material, ink outline, warm key light plus a rim light, contact shadow, transparent background.
6. **Stages:** the same TV stage and room stage as in 2D.
7. **Switching:** `?view=3d` / `?view=2d`. 2D stays the default until 3D is approved.
8. **Check sheet:** `poses.html` shows 2D and 3D side by side for every mood and hand pose.
9. **Performance:** a perf HUD behind `?perf` (fps, frame time, draw calls, memory), with the numbers recorded in the docs.

**The only design job** is to look at the check sheet and say what feels wrong (proportions, colours, outline thickness). That's commenting, not modelling.

**Done when:** in 3D, every mood reads the same as in 2D; `[wave]`, `[turn_around]` (her back shows), `[jump]` and `[sit]` work mid-conversation without a restart; and it holds at least 60 fps on this machine.

### M2: She feels alive (2 weeks)

Smooth crossfades, blinks, gaze and lip-sync already exist, because springs blend everything. What's new:

1. **Clip format** (`packages/character/src/clip.ts`): keyframes over a subset of parameters, with timing and easing. It's reused later by Pose Studio and props.
2. **Gesture layer** (`gestures.ts`): a gesture overrides only the parameters it owns, then hands back to the mood, so return-to-rest happens automatically. First set:
   - wave (moved out of `rig.ts`)
   - explain (open palms, alternating)
   - point (left, right, at the user)
   - shrug
   - nod
   - head shake
   - think (glove to chin)
   - "ta-da"
3. **New `nod` and `turn` parameters:** additive changes; the ESP32 ignores them.
4. **Beat gestures:** small hand movements on stressed words, using `speech.marks`, with a cooldown so they aren't constant.
5. **State machine** for idle, listening, thinking, speaking and acting, with watchdogs:
   - speaking with no audio for 3 s → idle
   - stuck thinking → idle
   - brain disconnects → idle
6. **Interruption:** when speech is cancelled, her mouth closes in about 150 ms and the gesture ends at a natural point instead of freezing. Actions that must finish first complete, then stop.
7. **Gesture tags in the brain:** `[point]`, `[shrug]`, `[nod]` go through the existing `TagFilter` (the body declares a `gesture` capability listing them; `tags.ts` reads it like `animate`). The limit of 2 per reply stays.

**Tests:** seeded rig tests: after each gesture, parameters return to the mood preset within 1 s; cancelling mid-gesture ends cleanly; the state machine never stays in speaking without audio.

**Done when:** she can listen, speak, wave, explain with her hands, react with expressions and move between actions without snapping or getting stuck.

### M3: She lives on the desktop (2 weeks)

Decisions to confirm:

- **Shell: Electron.** Its Chromium behaves exactly like the browser body: WebGL, mic, VAD, audio. Tauri on Linux uses WebKitGTK, which is weaker at WebGL and transparency.
- **Wayland:** depends on the M0 test. Most likely her window runs through XWayland (`--ozone-platform=x11`) so she can position it. The fallback is a KDE-specific KWin script driven over D-Bus.

Tasks:

1. **`apps/desktop`:** an Electron main process (windows, displays, tray, hotkeys) and a minimal typed bridge (context isolation on, no Node in the renderer). It loads the web-body build in desktop mode (no TV, no intro).
2. **A window her size** (about 320×400) that travels as she walks. `Motion.x` drives the window position, the stage is the whole desktop, and her floor is the top of the panel on that monitor.
3. **Click-through:** the window is shaped to her silhouette (Electron `setShape`, refreshed about 15 times a second), so clicks next to her reach other apps.
4. **Dragging:** she can be dragged and reacts (surprise, then a squashy landing).
5. **Cross-monitor:** on adjacent screens she walks across. Otherwise she exits with a run-off or a poof, the window jumps, and she makes an entrance on the other screen.
6. **Tray controls:** mute mic, push-to-talk vs hands-free, hide, quiet mode, quit. A talk hotkey too, with the tray as fallback because Wayland global shortcuts are unreliable.
7. **Autostart:** she starts with the KDE session, and the brain runs as a systemd user service.
8. **Two proof tools with checked results:** `desktop.open` (a file inside approved folders) and `media.control` (play/pause/next through playerctl/MPRIS). The full tool system is M5.

**Done when:** she starts with the session, stands on the taskbar, walks around without blocking clicks, can be dragged, moves to another monitor (if there is one), opens an approved file and pauses music, and reacts to each result.

### M4: Acting and personality (1–2 weeks)

1. **Acting profile per mood** (`packages/character/src/acting.ts`):
   - gesture energy and which gestures fit
   - gaze (when concerned she holds eye contact, fewer eye darts)
   - blink rate, fidgeting, and whether she wanders
2. **Voice per mood:** Kokoro speed per sentence (concerned 0.92×, excited 1.07×) and longer pauses when serious (brain `speech-out.ts`).
3. **Mood-change reactions:** when she becomes concerned or sad, she stops the current gesture, stops wandering, comes closer and softens.
4. **Variety without noise:** timing jitter, mirrored gestures, cooldowns per gesture, caps on blinks and fidgets, and permission to just stand there.
5. **Vocabulary:** keep the existing 15 moods, which already cover curious, concerned, amused (playful) and confident (proud). Add only `skeptical` and `reassuring` (additive protocol change, presets, regenerated firmware tables, fixtures).
6. **`persona.md` acting section:** when to gesture, restraint, and memories shape her tone but never trigger moves.
7. **Acting eval script** (`apps/brain/scripts/eval-acting.ts`): about 25 scripted lines ("my dog died", "I got the job", "is this a good idea?") run against the real model, checking her moods and moves. For example, bad news must never get a `[dance]`. Run by hand after prompt changes.

**Done when:** the same character visibly acts 5+ moods, the eval passes at least 90%, and bad news gets stillness and a slower voice, not just a sad face.

### M5: Tools that tell the truth (2–3 weeks)

1. **Body-backed skills:** desktop tools go into the existing `SkillRegistry` and execute through `CapabilityRouter`. That keeps one policy gate, and the fixed tool list keeps prompt caching working.
2. **Tools v1:**
   - `desktop.search`: approved folders; by name, then by content with ripgrep
   - `desktop.read_text`: txt, md, pdf (via pdftotext), with a size cap
   - `desktop.open`, `desktop.reveal`
   - `media.control`, `media.play`
   - `window.move_to_display`
   - `companion.go_near` (stand next to an app window), only if the window geometry can be read
3. **Approved folders** live in a config file (`~/.config/ms-minutes/desktop.json`) and are checked in Electron's main process (no `..`, no symlink escapes). The LLM never decides what's allowed.
4. **Honest results:** each result is `confirmed` (checked), `requested` (the OS was asked but it can't be checked) or `failed`, with a reason. She says "it's open" only when it's confirmed.
5. **Confirmations:** new protocol messages `confirm.request` / `confirm.response`. She asks out loud and shows Yes/No, and a spoken "yes" works too. This unlocks tier 3, which `apps/brain/src/modules/skills/policy.ts` refuses today.
6. **Task turns:** more than today's limit of 4 model calls per turn, per-tool timeouts, and "stop" / "never mind" cancels whatever is running.
7. **Activity log:** every tool call (arguments, decision, result, time) is in the turn traces and visible in a small panel.
8. **Model choice:** small local models (gemma4) are weak at multi-step tool use. The option is Claude for task turns and the local model for chat (see section 6).

**Done when:** "find my interview notes and show them while you explain the important topics" runs end to end:

1. Search the approved folders.
2. Ask which file if two match.
3. Open the chosen file.
4. Confirm it opened.
5. Move next to the window if possible.
6. Explain while speaking and gesturing.

A forced failure (file moved, player not running) is reported honestly.

### M6: Physical acting (3–4 weeks, then ongoing)

1. **Clip library by behaviour:** `clips/locomotion`, `interactions`, `desktop`, `effects` (JSON).
2. **Sequencer:** steps can be a clip, walk to, wait for an event, attach, detach or an effect. If any step fails, the sequence stops cleanly and reports why.
3. **Props:** CC0 GLB teacup, book, TV, chair, with a hand socket on each glove and interaction targets.
4. **Tea:** Reach → Grasp → Lift → Drink → Lower → Release.
5. **Effects and sounds:** poof and appear, sparkles, ticks, boing, bells, a sip (small CC0 sounds).
6. **Desktop acting:** pointing at the file she opened, looking at the video, walking off-screen.
7. **Pose Studio** for making new moves without Blender.

**Done when:** three multi-step interactions run 20 out of 20 times, and each can be interrupted cleanly.

### M7: Arm and RC car (separate track)

1. **Each device is a body.** The architecture already plans this. A local gateway per device enforces limits, a watchdog and the e-stop; the brain only sends intents.
2. **Bounded commands:**
   - arm: `arm.home`, `arm.move_to {preset}`, `arm.joint {joint, deg}` (clamped), `arm.grip`
   - car: `car.drive {speed ≤ 0.3, ≤ 2 s}`, `car.turn`, `car.stop`
   - `stop` is always allowed and acts instantly
   - status arrives as `event.sensor` (joints, moving, fault); results come after the motion completes, with the measured position
3. **Simulators first:** a simulated arm and car (bodies like `stub-body`) with a small Three.js view, so the whole flow is tested before any motor is connected.
4. **Real hardware, in order:** bounded moves, then calibration and position feedback, then a hardware e-stop that cuts motor power, then obstacle stopping for the car.
5. **Tier 3** means confirmation (from M5), plus a validator, plus device-side limits.
6. **She reacts only to confirmed device events.** She never claims a move happened without one.

**Needed first:** which hardware (servos, controller board, sensors).

**Done when:** a command can be validated, executed, monitored and safely stopped, and she reports the actual device result.

### M8: Hardening, attached to each milestone

| Milestone | Hardening work                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Disconnect tests: pending calls fail when a body drops                                                                                  |
| M1        | 8-hour render soak test (memory and fps flat); fallbacks for missing assets                                                             |
| M2        | Watchdogs for stuck states                                                                                                              |
| M3        | Crash restart (systemd `Restart=on-failure`), display hot-plug, display scaling, mic permission denied                                  |
| M5        | Local auth token between the desktop app and the brain; tests that approved folders are enforced; logs of AI decisions and tool results |
| M7        | Device safety tests                                                                                                                     |
| Final     | Scripted 8-hour "day in the life" run (talk, timers, files, music, monitor moves)                                                       |

Already in place: `.env` and `data/` are gitignored, and the brain listens only on 127.0.0.1.

---

## 5. Main risks

| Risk                                         | Mitigation                                                   |
| -------------------------------------------- | ------------------------------------------------------------ |
| Wayland stops her window from moving         | Test in M0; XWayland; KWin script fallback                   |
| Local gemma4 is weak at multi-step tool use  | Claude for task turns, or tighter tools with fewer steps     |
| An always-on WebGL window costs too much GPU | Lower frame rate when idle, pause when hidden, measure in M1 |
| 3D loses her charm                           | 2D stays the default until 3D is approved                    |
| Marvel/Disney character in a public repo     | Personal fan project only; original look if ever released    |

---

## 6. Open decisions

1. **3D body:** OK to build it in code with no Blender?
2. **Desktop shell:** Electron? And OK to run her window through XWayland if the M0 test calls for it?
3. **Model for tasks:** stay 100% local with gemma4 (what `.env` uses now), or use Claude for tool-heavy turns? This decides how reliable M5 can be.
4. **Order:** M0 → M6, with hardware as a separate track?
5. **Monitors:** only one 1920×1080 screen (HDMI-A-2) was detected. Is a second one planned? If not, cross-monitor work moves later.
6. **Arm and car hardware** (only matters for M7): what is already on hand?

Working rules once decisions are made: one branch per milestone (starting with `feat/m0-foundation`), plus ADRs for the 3D-body and desktop-shell decisions.

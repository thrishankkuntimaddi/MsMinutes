# Desk Companion — Firmware

Ms. Minutes' first physical body: an ESP32-S3 with a round display, an I²S microphone, an I²S amplifier and a talk button. It is a **thin client** (ARCHITECTURE §15): it renders her face, captures and plays audio, and speaks the Body Protocol over WebSocket. It never runs the LLM.

Parts, wiring and the bring-up order are in [docs/hardware/desk-companion.md](../../docs/hardware/desk-companion.md). The design is recorded in [ADR-0013](../../docs/adr/0013-desk-companion-firmware.md).

## What it does

| Hardware step | Firmware                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2            | Connects to the brain, sends `hello`, keeps heartbeats, reconnects with backoff. Renders `expression.set` and `state.set` with her rig, ported to C. Shows timers and rings alarms. |
| H3            | Push-to-talk: hold the button, 16 kHz PCM16 goes up as `event.audio.chunk`; her voice comes down as `speech.audio.chunk` and plays through the amp; the mouth follows the sound.    |
| H4 (later)    | Battery level is read and reported (`event.sensor`), low battery makes her sleepy. Wi-Fi provisioning, OTA and a wake word are still to come.                                       |

Her face fills the 240×240 display: the round screen is her clock case. A small dial window at 6 o'clock shows the time, a countdown while a timer runs, or `OFF` when the brain is unreachable.

## Layout

```
components/core   Portable C, no ESP-IDF: her rig (springs, presets, idle life), her face
                  (an anti-aliased RGB565 rasterizer), base64, the protocol codec
main              ESP-IDF glue: Wi-Fi, WebSocket link, display, I²S audio, button, battery
host              Builds `core` with a plain C compiler: tests against the protocol fixtures,
                  and draws her pose sheet
```

`components/core/rig_presets.c` is **generated** from `packages/character` (`pnpm firmware:presets`); a test fails if it drifts, so the device and the browser always share one face.

## Build and flash

Needs [ESP-IDF 5.3+](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/get-started/) with the ESP32-S3 target. Managed components (GC9A01 driver, WebSocket client) are fetched on the first build.

```sh
cd firmware/desk-companion
idf.py set-target esp32s3
idf.py menuconfig        # "Ms. Minutes desk companion": Wi-Fi, brain URL, body id, pins
idf.py build flash monitor
```

The brain must listen on the LAN, not only on localhost:

```sh
# in the repo's .env
HOST=0.0.0.0
TTS_PROVIDER=kokoro      # her voice, streamed to the device
STT_PROVIDER=local       # her hearing, for push-to-talk
```

Then `pnpm dev:brain`, and the body appears in `GET /api/bodies` as `desk-01`. Talk to her by holding the button; press it while she is speaking to interrupt her.

### Defaults

The pin map matches the wiring table in the hardware doc (ESP32-S3-DevKitC-1 N16R8). Everything is in `menuconfig`, including which parts are fitted: build with `DESK_HAS_MIC`, `DESK_HAS_SPEAKER` or `DESK_HAS_BATTERY` off while bringing the board up one part at a time. `sdkconfig.defaults` assumes 16 MB flash and octal PSRAM; an N8R2 board needs `CONFIG_SPIRAM_MODE_QUAD`.

### Bring-up, mapped to the hardware doc

1. **Board:** `idf.py monitor` logs `PSRAM 8192 KB` at boot.
2. **Display:** her face appears asleep (eyes half closed, `OFF` in the window). If colours look negative, turn off `DESK_LCD_INVERT`.
3. **Wi-Fi + protocol:** once joined, the log shows `connected to ws://… as desk-01`, then `Ms. Minutes is here`. She hops and smiles. The window shows the time after NTP sync.
4. **Expression:** talk to her from the browser body or the stub body; `expression.set` lands on the device as well when it's the active body (reply directives go to the body that spoke).
5. **Voice:** hold the button and talk. The log shows `heard N s`, then `she heard: …`, then audio plays.
6. **Timers:** "set a timer for one minute": the countdown sweeps the rim and the window counts down; her bells shake the face when it goes off.

## Host checks

```sh
pnpm firmware:check     # or: make -C firmware/desk-companion/host check
```

Compiles `components/core` with the host compiler, runs the tests (springs, rig, base64, every fixture in `packages/protocol/fixtures`), and writes `host/build/poses.png`, her pose sheet. CI runs the same.

## Not yet

- **Wake word and VAD on the device** (ADR-0010 puts VAD on the body). Push-to-talk first; ESP-SR or microWakeWord later.
- **Provisioning and OTA** (H4): Wi-Fi credentials are set in `menuconfig` for now. The partition table already has two OTA slots.
- **Binary audio frames**: audio is base64 inside JSON, as the protocol specifies today.
- **Authentication** (§13.4): the brain accepts any body on the LAN.
- **Arms and legs**: the display shows her face only, so the firmware does not port `Motion` and declares no `animate` capability.

# Desk Companion — Hardware

The first physical body of Ms. Minutes: a small retro clock with a round screen, a microphone, a speaker, Wi-Fi and its own battery.

It is a **thin client** (ADR-0001, ADR-0003). It renders the face, captures and plays audio, and speaks the Body Protocol. It never runs the LLM.

> Part numbers are suggestions that are widely available and well supported by ESP-IDF, Arduino and LVGL. Check the exact module pinout and voltage on the listing before buying. Buy **2× the cheap parts** (displays, mics, amps), because breadboard prototyping breaks things.

---

## 1. Block diagram

```
                  ┌──────────────────────────────────────────────┐
   USB-C ──► Charger/PMU ──► LiPo ──► 3.3 V rail ──► ESP32-S3 (Wi-Fi, PSRAM)
                  │                                   │   │   │   │
                  └──► VBAT ──► I²S amp ──► Speaker   │   │   │   │
                                     ▲                │   │   │   │
                                     └──── I²S out ───┘   │   │   │
            I²S MEMS mic ───────────────── I²S in ────────┘   │   │
            Round display (GC9A01, 240×240) ◄──── SPI ────────┘   │
            Button · mic-mute switch · battery sense ─── GPIO/ADC ┘
```

---

## 2. Bill of materials

### 2.1 Core (needed to build the body)

| #   | Part                  | Recommended                                                                                                                                                          | Why                                                                                                                                                                                                                              |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Microcontroller**   | **ESP32-S3** with PSRAM. Prototype: ESP32-S3-DevKitC-1 **N16R8** (16 MB flash, 8 MB PSRAM). Compact build: Seeed XIAO ESP32S3 (8 MB PSRAM, built-in LiPo charger).   | The S3 is required: it has vector instructions for audio and ML, Espressif's ESP-SR wake-word/VAD library runs only on S3, and PSRAM holds the frame buffer and audio buffers. Avoid the classic ESP32, C3 and C6 for this body. |
| 2   | **Display**           | **1.28" round IPS, 240×240, GC9A01, SPI** module                                                                                                                     | Round fits the retro clock face. Fallbacks: 1.54" square or 1.69" rounded-rectangle ST7789 (240×280).                                                                                                                            |
| 3   | **Microphone**        | **INMP441** I²S MEMS mic breakout (better: ICS-43434)                                                                                                                | Digital I²S output, so there's no analog noise. Works directly with the ESP32-S3 I²S peripheral.                                                                                                                                 |
| 4   | **Speaker amplifier** | **MAX98357A** I²S class-D amp breakout (~3 W)                                                                                                                        | Takes digital audio straight from I²S, needs no DAC, and runs directly from the battery (2.5–5.5 V).                                                                                                                             |
| 5   | **Speaker**           | 4 Ω or 8 Ω, 2–3 W, **28–40 mm** full-range                                                                                                                           | Big enough for intelligible speech, small enough to fit the case. Smaller speakers sound tinny.                                                                                                                                  |
| 6   | **Battery**           | 3.7 V **LiPo, 1000–2000 mAh**, with protection circuit, JST-PH 2.0 connector                                                                                         | Roughly 6–10 h of active use (see §5). Check the connector polarity matches your board.                                                                                                                                          |
| 7   | **Charger / power**   | Built into the XIAO or Feather. With a DevKitC: **TP4056 USB-C module with protection** + a 3.3 V buck-boost or LDO with low dropout (e.g. TPS63020 or ME6211 board) | Don't feed a LiPo into a DevKitC's 5 V pin. Its AMS1117 regulator drops ~1 V and browns out the board.                                                                                                                           |
| 8   | **Push button**       | 6×6 mm or 12×12 mm tactile switch                                                                                                                                    | Push-to-talk at first, later tap to wake/stop.                                                                                                                                                                                   |
| 9   | **Mic mute switch**   | Small slide switch that cuts power to the mic                                                                                                                        | A **hardware** privacy guarantee. Software can't override it.                                                                                                                                                                    |
| 10  | **Battery sense**     | 2× 100 kΩ resistors (voltage divider into an ADC1 pin)                                                                                                               | Battery level display, plus a "sleepy" expression when the battery is low.                                                                                                                                                       |
| 11  | **Bulk capacitor**    | 470–1000 µF electrolytic, ≥ 10 V, near the amp                                                                                                                       | Smooths speaker current spikes. Without it, Wi-Fi TX + audio peaks reset the board.                                                                                                                                              |

### 2.2 Prototyping supplies

| Part                                                     | Notes                                                    |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Breadboards (2× full size)                               | DevKitC is wide; two boards side by side                 |
| Jumper wires (M-M, M-F, F-F)                             | Dupont, 10–20 cm                                         |
| USB-C **data** cable                                     | Charge-only cables are the #1 "board not detected" cause |
| Header pins                                              | Most breakouts ship without headers soldered             |
| Soldering iron, solder, flux, wick                       | Needed for headers, the battery and the final build      |
| Multimeter                                               | Checking rails and battery voltage                       |
| Perfboard / protoboard                                   | For the first build that leaves the breadboard           |
| JST-PH 2.0 pigtails, heat-shrink, small wire (26–28 AWG) | For battery and speaker leads                            |

### 2.3 Optional (later phases)

| Part                                 | Use                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Touch sensor pad (TTP223) on the top | "Pat on the head" → happy expression                                                                          |
| IMU (e.g. QMI8658 / MPU-6050)        | Notices being picked up, shaken or tilted                                                                     |
| Ambient light sensor (BH1750)        | Dims the screen at night; sleepy mood in the dark                                                             |
| Small WS2812 RGB LED                 | Status light: listening / muted / charging                                                                    |
| 2× micro servo (SG90 / MG90S)        | Physical arms. Needs its own 5 V supply and a bigger battery, so it comes after the screen version is stable. |
| Second I²S mic                       | Far-field voice pickup / beamforming with ESP-SR AFE                                                          |
| Camera (OV2640 / OV5640)             | Phase 9 vision. The XIAO ESP32S3 _Sense_ includes one.                                                        |

### 2.4 Enclosure

- 3D-printed retro clock body (PLA/PETG), with a round bezel for the 1.28" display, a speaker grille and a USB-C cutout.
- Optional: a domed glass/acrylic lens over the display for the vintage-clock look, plus a wood or brass finish.
- If you have no printer: online printing services, or a small off-the-shelf round tin/clock case.

---

## 3. All-in-one alternative

If you'd rather start firmware **before** wiring anything, an off-the-shelf ESP32-S3 dev kit with screen + mic + speaker works too:

| Kit                                                        | Pros                                                                     | Cons                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| Espressif **ESP32-S3-BOX-3**                               | Official, ESP-SR wake-word demos work out of the box, dual mics, speaker | 2.4" square screen; not the final form factor |
| **M5Stack CoreS3**                                         | Screen, dual mics, speaker, battery, camera in one case                  | 2" square screen; less freedom over the look  |
| Round-display ESP32-S3 boards (e.g. Waveshare 1.28" round) | Exactly the round form factor                                            | Most lack mic/speaker; check the listing      |

**Recommendation:** build the **modular breadboard** version (§2.1). It's what the final device will be, it costs about the same, and it teaches you every part of the body. The firmware is the same either way, apart from a pin map.

---

## 4. Proposed wiring (ESP32-S3-DevKitC-1 N16R8)

Avoid strapping pins (GPIO 0, 3, 45, 46) and the octal-PSRAM pins (GPIO 35–37). Use ADC1 pins for analog (ADC2 can't be used while Wi-Fi is on). **Confirm against your board's pinout.**

| Function          | Part pin                    | ESP32-S3 GPIO | Notes                                     |
| ----------------- | --------------------------- | ------------- | ----------------------------------------- |
| Display SCLK      | GC9A01 SCL/SCK              | 12            | SPI2 (FSPI)                               |
| Display MOSI      | GC9A01 SDA/DIN              | 11            |                                           |
| Display CS        | GC9A01 CS                   | 10            |                                           |
| Display DC        | GC9A01 DC                   | 9             |                                           |
| Display RST       | GC9A01 RST                  | 14            |                                           |
| Display backlight | GC9A01 BL                   | 13            | PWM for brightness                        |
| Mic bit clock     | INMP441 SCK                 | 4             | I²S0 (RX)                                 |
| Mic word select   | INMP441 WS                  | 5             |                                           |
| Mic data          | INMP441 SD                  | 6             | L/R pin → GND (left channel)              |
| Amp bit clock     | MAX98357A BCLK              | 15            | I²S1 (TX)                                 |
| Amp word select   | MAX98357A LRC               | 16            |                                           |
| Amp data          | MAX98357A DIN               | 17            | Amp VIN → VBAT (or 5 V on USB), not 3.3 V |
| Button            | Switch → GND                | 18            | Internal pull-up                          |
| Battery sense     | Divider midpoint            | 1             | ADC1_CH0; 100 kΩ / 100 kΩ from VBAT       |
| Mic power         | INMP441 VDD via mute switch | 3V3           | Hardware mute                             |

On the XIAO ESP32S3 (11 GPIOs), put the mic and amp on **one full-duplex I²S** (shared BCLK/WS). Tie display RST to EN and the backlight to a single PWM pin. That fits in about 10 pins.

---

## 5. Power budget (rough)

| Load                                   | Typical     | Peak                    |
| -------------------------------------- | ----------- | ----------------------- |
| ESP32-S3, Wi-Fi connected, active      | 80–120 mA   | ~350–500 mA (TX bursts) |
| Display + backlight                    | 20–40 mA    |                         |
| Mic                                    | ~1.5 mA     |                         |
| Amp + speaker while talking            | 50–300 mA   | ~1 A                    |
| **Total average (idle-ish, Wi-Fi on)** | **~150 mA** | **~1.5 A**              |

- A 1500 mAh battery gives about **8–10 h** of active desk use. Light sleep + display dimming when idle extends that a lot.
- The battery, protection circuit and charger must handle **~1.5 A peaks**.
- On the desk it will mostly run on USB-C anyway. The battery is for moving it around and for surviving unplugging.

---

## 6. Firmware stack

| Concern           | Choice                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Framework         | **ESP-IDF 5.x** (C/C++). Arduino is fine for bring-up tests, but ESP-IDF gives full control of I²S, PSRAM, ESP-SR and OTA. |
| Graphics          | **LVGL** (or a direct framebuffer for the face), driving the GC9A01 over SPI with DMA                                      |
| Character         | Port of `packages/character`: parameter rig + JSON presets, same as the web prototype (ARCHITECTURE §9)                    |
| Brain connection  | `esp_websocket_client` + cJSON, speaking the Body Protocol (validated against `packages/protocol/schema/*.json`)           |
| Audio in          | I²S RX 16 kHz. INMP441 gives 24-bit samples in 32-bit slots, converted to 16-bit PCM before sending                        |
| Audio out         | I²S TX, PCM16 from the brain                                                                                               |
| Wake word / VAD   | Start with **push-to-talk** (the button). Then ESP-SR (WakeNet + AFE/VAD), or **microWakeWord** for a custom "Hey Minutes" |
| Wi-Fi setup       | ESP-IDF provisioning (BLE or SoftAP), so credentials are never hard-coded                                                  |
| Updates           | OTA over HTTPS from the brain                                                                                              |
| Safety/robustness | Reconnect with backoff; show an "offline" expression when the brain is unreachable; watchdog                               |

Firmware lives in `firmware/desk-companion/`.

---

## 7. Bring-up order

Test each part **on its own** before combining them. That way, when something fails, you know which part it is.

1. **Board:** flash the blink example; confirm PSRAM is detected (`idf.py monitor` shows 8 MB PSRAM).
2. **Display:** draw a solid colour, then a circle, then the static face.
3. **Speaker:** play a sine tone through the MAX98357A.
4. **Mic:** record 3 s and play it back through the speaker (loopback test).
5. **Wi-Fi + protocol:** connect to the brain, send `hello`, receive `welcome`, keep heartbeats. The body appears in `GET /api/bodies`.
6. **Expression:** the brain sends `expression.set` and the face changes on the real screen.
7. **Voice:** push-to-talk audio goes up, TTS audio comes down, the mouth moves with amplitude.
8. **Battery:** run untethered, read battery level, charge over USB-C.
9. **Enclosure:** move from breadboard to protoboard to the printed case.

/*
 * Host tests for the firmware's portable core. Run with the path to
 * packages/protocol/fixtures: the protocol codec must agree with the brain's schemas.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "b64.h"
#include "cJSON.h"
#include "face.h"
#include "protocol.h"
#include "rig.h"

static int failures = 0;

#define CHECK(cond, ...)                                 \
  do {                                                   \
    if (!(cond)) {                                       \
      failures++;                                        \
      fprintf(stderr, "  ✗ %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);                      \
      fprintf(stderr, "\n");                             \
    }                                                    \
  } while (0)

static char *read_file(const char *dir, const char *name) {
  char path[1024];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "can't open %s\n", path);
    exit(2);
  }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = malloc((size_t)n + 1);
  if (fread(buf, 1, (size_t)n, f) != (size_t)n) exit(2);
  buf[n] = '\0';
  fclose(f);
  return buf;
}

/* ---------- rig ---------- */

static void test_spring(void) {
  rig_spring_t s;
  rig_spring_init(&s, 0, 200, 0.5f);
  s.target = 1;
  float peak = 0;
  for (int i = 0; i < 240; i++) peak = fmaxf(peak, rig_spring_step(&s, 1.0f / 60));
  CHECK(peak > 1, "an underdamped spring overshoots (peak %f)", peak);
  CHECK(fabsf(s.value - 1) < 1e-3f, "and settles on its target (%f)", s.value);

  /* Her stiffest spring stays bounded at 30 fps or slower (the sub-step fix). */
  rig_spring_init(&s, 0, 900, 0.78f);
  for (int i = 0; i < 600; i++) {
    s.target = i % 20 < 10 ? 1 : 0;
    rig_spring_step(&s, 1.0f / 30);
    CHECK(fabsf(s.value) < 3, "stiff spring blew up at step %d: %f", i, s.value);
    if (fabsf(s.value) >= 3) return;
  }
}

static void test_rig(void) {
  rig_t rig;
  rig_init(&rig, 42);
  CHECK(rig_affect_from_name("happy") == AFFECT_HAPPY, "affect names resolve");
  CHECK(rig_affect_from_name("bored") == -1, "unknown affects are rejected");
  CHECK(strcmp(RIG_AFFECT_NAMES[AFFECT_PROUD], "proud") == 0, "generated names are in order");

  rig_frame_t f;
  bool blinked = false;
  for (int i = 0; i < 600; i++) {
    rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
    if (f.blink_l > 0.9f) blinked = true;
    CHECK(fabsf(f.p[RIG_BOUNCE]) < 10, "idle bounce stays small (%f)", f.p[RIG_BOUNCE]);
  }
  CHECK(blinked, "she blinks within ten seconds");
  CHECK(fabsf(f.p[RIG_MOUTH_CURVE] - RIG_NEUTRAL[RIG_MOUTH_CURVE]) < 0.05f,
        "neutral at rest (mouthCurve %f)", f.p[RIG_MOUTH_CURVE]);
  CHECK(fabsf(f.hour_angle - (3.25f / 12) * 6.2831853f) < 1e-3f, "hour hand at quarter past 3");

  rig_set_expression(&rig, AFFECT_HAPPY, 1, NULL, NULL, 0);
  for (int i = 0; i < 120; i++) rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
  CHECK(f.p[RIG_MOUTH_CURVE] > 0.9f, "happy curves her mouth (%f)", f.p[RIG_MOUTH_CURVE]);
  CHECK(f.p[RIG_CHEEK] > 0.6f, "and blushes (%f)", f.p[RIG_CHEEK]);

  /* Half intensity lands halfway, as blendTargets does. */
  rig_set_expression(&rig, AFFECT_HAPPY, 0.5f, NULL, NULL, 0);
  float expected = RIG_NEUTRAL[RIG_MOUTH_CURVE] + RIG_PRESET_DELTA[AFFECT_HAPPY][RIG_MOUTH_CURVE] * 0.5f;
  CHECK(fabsf(rig.targets[RIG_MOUTH_CURVE] - expected) < 1e-5f, "intensity scales the preset");

  int blend_a[1] = {AFFECT_SLEEPY};
  float blend_w[1] = {1};
  rig_set_expression(&rig, AFFECT_HAPPY, 1, blend_a, blend_w, 1);
  CHECK(rig.targets[RIG_EYE_OPEN] < RIG_NEUTRAL[RIG_EYE_OPEN], "blends add: happy + sleepy droops");

  rig_set_mode(&rig, RIG_MODE_THINKING);
  for (int i = 0; i < 120; i++) rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
  CHECK(f.p[RIG_PUPIL_Y] < -0.3f, "thinking looks up (%f)", f.p[RIG_PUPIL_Y]);

  rig_set_mode(&rig, RIG_MODE_SPEAKING);
  rig_viseme_t v = {0.8f, 0.1f, 1.1f};
  rig_set_viseme(&rig, &v);
  for (int i = 0; i < 30; i++) rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
  CHECK(f.p[RIG_MOUTH_OPEN] > 0.4f, "a viseme opens her mouth (%f)", f.p[RIG_MOUTH_OPEN]);
  rig_set_viseme(&rig, NULL);
  rig_ring(&rig, 0.5f);
  rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
  CHECK(f.ring == 1, "ringing");
  for (int i = 0; i < 120; i++) rig_update(&rig, 1.0f / 60, 3, 15, 0, &f);
  CHECK(f.ring == 0, "bells fade out");
}

/* ---------- base64 ---------- */

static void test_b64(void) {
  const uint8_t in[] = {0, 255, 127, 128, 1, 2, 3};
  char enc[64];
  uint8_t dec[64];
  for (size_t n = 0; n <= sizeof in; n++) {
    size_t len = b64_encode(in, n, enc);
    CHECK(len == ((n + 2) / 3) * 4, "encoded length for %zu bytes", n);
    size_t got = b64_decode(enc, len, dec);
    CHECK(got == n && memcmp(in, dec, n) == 0, "round trip of %zu bytes", n);
  }
  CHECK(strcmp(enc, "AP9/gAECAw==") == 0, "known encoding (%s)", enc);
  CHECK(b64_decode("@@@@", 4, dec) == 0, "garbage is rejected");
  size_t pcm = b64_decode("AAD/f/9/AAABgAGAAAA=", 20, dec);
  CHECK(pcm == 14, "fixture audio decodes to 14 bytes (%zu)", pcm);
  int16_t s1;
  memcpy(&s1, dec + 2, 2);
  CHECK(s1 == 32767, "little-endian PCM16 (%d)", s1);
}

/* ---------- protocol ---------- */

static uint64_t fake_now(void) { return 1759640400000ull; }
static void fake_uuid(char out[37]) { strcpy(out, "00000000-0000-4000-8000-000000000001"); }

static void test_parse_fixtures(const char *dir) {
  char *text = read_file(dir, "brain-to-body.json");
  cJSON *all = cJSON_Parse(text);
  CHECK(all != NULL, "fixtures parse");
  int count = 0;
  cJSON *entry;
  cJSON_ArrayForEach(entry, all) {
    count++;
    char *raw = cJSON_PrintUnformatted(entry);
    brain_msg_t msg;
    proto_result_t r = protocol_parse(raw, strlen(raw), &msg);
    CHECK(r == PROTO_OK, "%s parses (%d)", entry->string, r);
    CHECK(protocol_validate(&msg), "%s validates", entry->string);
    CHECK(strcmp(protocol_type_name(msg.type), entry->string) == 0, "%s has its type (%s)",
          entry->string, protocol_type_name(msg.type));
    switch (msg.type) {
      case BRAIN_MSG_WELCOME: {
        proto_welcome_t w;
        CHECK(protocol_welcome(&msg, &w), "welcome payload");
        CHECK(w.heartbeat_interval_ms == 15000 && w.audio && w.hearing, "welcome fields");
        CHECK(strcmp(w.persona_name, "Ms. Minutes") == 0, "persona name");
        CHECK(msg.reply_to && strlen(msg.reply_to) > 0, "welcome replies to the hello");
        break;
      }
      case BRAIN_MSG_STATE_SET: {
        rig_mode_t mode;
        CHECK(protocol_state(&msg, &mode) && mode == RIG_MODE_THINKING, "state.set mode");
        break;
      }
      case BRAIN_MSG_EXPRESSION_SET: {
        proto_expression_t e;
        CHECK(protocol_expression(&msg, &e), "expression payload");
        CHECK(e.affect == AFFECT_HAPPY && fabsf(e.intensity - 0.7f) < 1e-5f, "expression fields");
        CHECK(e.blend_count == 1 && e.blend_affects[0] == AFFECT_SLEEPY, "expression blend");
        break;
      }
      case BRAIN_MSG_SPEECH_AUDIO_CHUNK: {
        proto_audio_chunk_t c;
        CHECK(protocol_audio_chunk(&msg, &c), "audio chunk payload");
        CHECK(c.pcm16 && c.sample_rate == 24000 && c.seq == 0, "audio chunk fields");
        uint8_t pcm[64];
        CHECK(b64_decode(c.data, c.data_len, pcm) == 14, "audio chunk decodes");
        break;
      }
      case BRAIN_MSG_CAPABILITY_CALL: {
        proto_call_t call;
        CHECK(protocol_capability_call(&msg, &call), "capability call payload");
        CHECK(strcmp(call.name, "display.timer") == 0, "capability name");
        cJSON *timers = cJSON_GetObjectItemCaseSensitive(call.args, "timers");
        CHECK(cJSON_IsArray(timers) && cJSON_GetArraySize(timers) == 1, "timer list");
        break;
      }
      case BRAIN_MSG_ERROR: {
        proto_error_t err;
        CHECK(protocol_error(&msg, &err) && !err.fatal, "error payload");
        break;
      }
      case BRAIN_MSG_TRANSCRIPT: {
        const char *t;
        CHECK(protocol_transcript(&msg, &t) && strstr(t, "timer"), "transcript text");
        break;
      }
      default: {
        const char *turn;
        CHECK(protocol_turn_id(&msg, &turn), "%s carries a turnId", entry->string);
        break;
      }
    }
    protocol_free(&msg);
    free(raw);
  }
  CHECK(count == 11, "every brain → body type has a fixture (%d)", count);
  cJSON_Delete(all);
  free(text);
}

static void test_invalid_fixtures(const char *dir) {
  char *text = read_file(dir, "invalid.json");
  cJSON *all = cJSON_Parse(text);
  cJSON *entry;
  cJSON_ArrayForEach(entry, all) {
    const char *name = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(entry, "name"));
    const char *code = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(entry, "code"));
    const char *direction =
        cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(entry, "direction"));
    /* The firmware only decodes brain → body messages; body ids are checked both ways. */
    cJSON *raw_item = cJSON_GetObjectItemCaseSensitive(entry, "raw");
    char *raw = cJSON_IsString(raw_item)
                    ? strdup(raw_item->valuestring)
                    : cJSON_PrintUnformatted(cJSON_GetObjectItemCaseSensitive(entry, "message"));
    brain_msg_t msg;
    proto_result_t r = protocol_parse(raw, strlen(raw), &msg);
    if (r == PROTO_OK && !protocol_validate(&msg)) r = PROTO_INVALID_MESSAGE;
    proto_result_t want = strcmp(code, "invalid_json") == 0            ? PROTO_INVALID_JSON
                          : strcmp(code, "unsupported_version") == 0 ? PROTO_UNSUPPORTED_VERSION
                                                                     : PROTO_INVALID_MESSAGE;
    /* A body-to-brain type is "unknown" to this decoder, which is also invalid_message. */
    (void)direction;
    CHECK(r == want, "%s → %s (got %d)", name, code, r);
    protocol_free(&msg);
    free(raw);
  }
  cJSON_Delete(all);
  free(text);
}

/* The messages this body sends must be what the brain's schemas accept. */
static void test_build(const char *dir) {
  proto_env_t env = {"desk-01", fake_now, fake_uuid};
  char *expect_text = read_file(dir, "body-to-brain.json");
  cJSON *expect = cJSON_Parse(expect_text);

  struct {
    const char *type;
    char *json;
  } built[] = {
      {"hello", protocol_hello(&env, "desk_companion", "0.1.0", true, true)},
      {"heartbeat", protocol_heartbeat(&env)},
      {"event.utterance.text", protocol_utterance_text(&env, "hi")},
      {"event.audio.chunk", protocol_audio_chunk_msg(&env, 3, 16000, "AAAA")},
      {"event.audio.end", protocol_audio_end(&env)},
      {"event.interrupt", protocol_interrupt(&env)},
      {"event.sensor", protocol_sensor(&env, "battery", NULL)},
      {"capability.result", protocol_capability_result(&env, "c1", false, "unsupported", "no")},
  };
  for (size_t i = 0; i < sizeof built / sizeof built[0]; i++) {
    CHECK(built[i].json != NULL, "%s builds", built[i].type);
    if (!built[i].json) continue;
    cJSON *msg = cJSON_Parse(built[i].json);
    CHECK(msg != NULL, "%s is JSON", built[i].type);
    cJSON *fixture = cJSON_GetObjectItemCaseSensitive(expect, built[i].type);
    CHECK(fixture != NULL, "%s has a fixture", built[i].type);
    /* Same envelope keys as the fixture, and the same payload keys. */
    for (cJSON *k = fixture->child; k; k = k->next) {
      if (strcmp(k->string, "replyTo") == 0) continue;
      CHECK(cJSON_HasObjectItem(msg, k->string), "%s has envelope key %s", built[i].type, k->string);
    }
    cJSON *payload = cJSON_GetObjectItemCaseSensitive(msg, "payload");
    cJSON *want = cJSON_GetObjectItemCaseSensitive(fixture, "payload");
    for (cJSON *k = want->child; k; k = k->next) {
      bool optional = strcmp(k->string, "data") == 0 && strcmp(built[i].type, "capability.result") == 0;
      if (optional) continue;
      CHECK(cJSON_HasObjectItem(payload, k->string), "%s payload has %s", built[i].type, k->string);
    }
    CHECK(cJSON_GetObjectItemCaseSensitive(msg, "v")->valuedouble == 1, "%s is protocol v1",
          built[i].type);
    CHECK(strcmp(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "type")),
                 built[i].type) == 0,
          "%s type", built[i].type);
    if (strcmp(built[i].type, "hello") == 0) {
      cJSON *caps = cJSON_GetObjectItemCaseSensitive(payload, "capabilities");
      CHECK(cJSON_GetArraySize(caps) == 5, "hello declares 5 capabilities");
      bool listen = false;
      cJSON *c;
      cJSON_ArrayForEach(c, caps) {
        if (strcmp(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(c, "name")), "listen") == 0) {
          listen = cJSON_GetObjectItemCaseSensitive(c, "riskTier")->valuedouble == 2;
        }
      }
      CHECK(listen, "listening is tier 2");
    }
    cJSON_Delete(msg);
    free(built[i].json);
  }
  cJSON_Delete(expect);
  free(expect_text);
}

/* ---------- face ---------- */

static void test_face(void) {
  static uint16_t px[FACE_W * FACE_H];
  static uint8_t mask_px[FACE_W * FACE_H];
  gfx_fb_t fb = {FACE_W, FACE_H, px};
  gfx_mask_t mask = {FACE_W, FACE_H, mask_px, 0, 0, FACE_W - 1, FACE_H - 1};
  gfx_mask_clear(&mask);
  rig_t rig;
  rig_init(&rig, 1);
  rig_frame_t f;
  /* Look right, so the left of her left eye is white whatever the saccades do. */
  rig_look_at(&rig, 1, 0, 10);
  for (int i = 0; i < 60; i++) rig_update(&rig, 1.0f / 60, 10, 8, 0, &f);
  face_timer_t timer = {.active = true, .remaining = 0.5f};
  face_format_countdown(149, timer.readout);
  CHECK(strcmp(timer.readout, "2:29") == 0, "countdown formats m:ss (%s)", timer.readout);
  face_format_countdown(3725, timer.readout);
  CHECK(strcmp(timer.readout, "1:02") == 0, "and h:mm past an hour (%s)", timer.readout);
  face_status_t status = {.online = true, .clock = "10:08"};
  face_draw(&fb, &mask, &f, &timer, &status);

  gfx_rgb_t corner = gfx_unpack(px[0]);
  CHECK(corner.r < 20 && corner.g < 20, "corners are dark (outside the round display)");
  gfx_rgb_t forehead = gfx_unpack(px[(120 - 85) * FACE_W + 120 + 40]);
  CHECK(forehead.r > 200 && forehead.g > 100 && forehead.g < 200 && forehead.b < 120,
        "her face is orange (%d,%d,%d)", forehead.r, forehead.g, forehead.b);
  gfx_rgb_t rim = gfx_unpack(px[120 * FACE_W + (120 - 113)]);
  CHECK(rim.r > 180 && rim.g > 100 && rim.b < 100, "gold rim (%d,%d,%d)", rim.r, rim.g, rim.b);
  gfx_rgb_t top = gfx_unpack(px[(120 - 113) * FACE_W + 120]);
  CHECK(top.r > 200 && top.g < 120, "countdown arc at 12 o'clock (%d,%d,%d)", top.r, top.g, top.b);
  gfx_rgb_t white = gfx_unpack(px[(int)(120 - 18 * 1.15f) * FACE_W + (int)(120 - 33 * 1.15f - 16)]);
  CHECK(white.r > 230 && white.g > 220, "the whites of her eyes (%d,%d,%d)", white.r, white.g,
        white.b);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: test_core <packages/protocol/fixtures>\n");
    return 2;
  }
  test_spring();
  test_rig();
  test_b64();
  test_parse_fixtures(argv[1]);
  test_invalid_fixtures(argv[1]);
  test_build(argv[1]);
  test_face();
  if (failures) {
    fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
  }
  printf("firmware core: all checks passed\n");
  return 0;
}

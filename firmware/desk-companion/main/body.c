#include "body.h"

#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "app.h"
#include "audio_in.h"
#include "audio_out.h"
#include "b64.h"
#include "battery.h"
#include "brain_link.h"
#include "button.h"
#include "cJSON.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "face.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "rig.h"
#include "sdkconfig.h"
#include "wifi.h"

static const char *TAG = "body";

#define MAX_TIMERS 8
#define FRAME_MS 33
#define LOW_BATTERY_PERCENT 15
#define BATTERY_CHECK_MS 60000
#define BATTERY_REPORT_MS 300000
#define RING_FOR_MS 8000

typedef struct {
  bool is_timer;
  char label[48];
  int64_t ends_at_ms;
  int duration_s; /* 0 for reminders */
} shown_timer_t;

static struct {
  SemaphoreHandle_t lock;
  rig_t rig;
  gfx_fb_t fb;
  gfx_mask_t mask;
  uint8_t *pcm_scratch; /* decoded voice chunk */
  link_status_t link;
  bool link_started;
  bool brain_speaks, brain_hears;
  rig_mode_t brain_mode;
  /* The brain's last expression, and a short one of her own layered on top. */
  int affect;
  float intensity;
  int brief_affect;
  float brief_intensity;
  int64_t brief_until_ms;
  shown_timer_t timers[MAX_TIMERS];
  int timer_count;
  int64_t ringing_until_ms;
  bool low_battery;
  int64_t battery_checked_ms, battery_reported_ms;
} S;

static int64_t uptime_ms(void) { return esp_timer_get_time() / 1000; }

static int64_t wall_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

/* Call with the lock held. */
static void apply_expression(void) {
  int affect = S.affect;
  float intensity = S.intensity;
  if (S.brief_until_ms > uptime_ms()) {
    affect = S.brief_affect;
    intensity = S.brief_intensity;
  }
  int blend[1] = {AFFECT_SLEEPY};
  float weight[1] = {0.5f};
  rig_set_expression(&S.rig, affect, intensity, blend, weight, S.low_battery ? 1 : 0);
}

static void express_briefly(int affect, float intensity, int ms) {
  S.brief_affect = affect;
  S.brief_intensity = intensity;
  S.brief_until_ms = uptime_ms() + ms;
  apply_expression();
}

/* ---------- what the brain says ---------- */

static void show_timers(cJSON *args) {
  cJSON *list = cJSON_GetObjectItemCaseSensitive(args, "timers");
  S.timer_count = 0;
  cJSON *t;
  cJSON_ArrayForEach(t, list) {
    if (S.timer_count == MAX_TIMERS) break;
    shown_timer_t *s = &S.timers[S.timer_count];
    const char *kind = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(t, "kind"));
    const char *label = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(t, "label"));
    cJSON *ends = cJSON_GetObjectItemCaseSensitive(t, "endsAt");
    cJSON *dur = cJSON_GetObjectItemCaseSensitive(t, "durationSec");
    if (!cJSON_IsNumber(ends)) continue;
    s->is_timer = kind && strcmp(kind, "timer") == 0;
    snprintf(s->label, sizeof s->label, "%s", label ? label : "");
    s->ends_at_ms = (int64_t)ends->valuedouble;
    s->duration_s = cJSON_IsNumber(dur) ? (int)dur->valuedouble : 0;
    S.timer_count++;
  }
  ESP_LOGI(TAG, "%d timer(s) on her face", S.timer_count);
}

static void on_call(const proto_call_t *call) {
  const proto_env_t *env = brain_link_env();
  if (strcmp(call->name, "display.timer") == 0) {
    show_timers(call->args);
    brain_link_send(protocol_capability_result(env, call->call_id, true, NULL, NULL));
  } else if (strcmp(call->name, "alarm.ring") == 0) {
    const char *label = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(call->args, "label"));
    ESP_LOGI(TAG, "ring! %s", label ? label : "");
    rig_ring(&S.rig, 0.9f);
    rig_hop(&S.rig, 1);
    S.ringing_until_ms = uptime_ms() + RING_FOR_MS;
    brain_link_send(protocol_capability_result(env, call->call_id, true, NULL, NULL));
  } else {
    char why[96];
    snprintf(why, sizeof why, "this body can't %s", call->name);
    brain_link_send(protocol_capability_result(env, call->call_id, false, "unsupported", why));
  }
}

static void on_message(const brain_msg_t *msg, void *ctx) {
  (void)ctx;
  xSemaphoreTake(S.lock, portMAX_DELAY);
  switch (msg->type) {
    case BRAIN_MSG_WELCOME: {
      proto_welcome_t w;
      protocol_welcome(msg, &w);
      S.brain_speaks = w.audio;
      S.brain_hears = w.hearing;
      if (!w.audio) ESP_LOGW(TAG, "the brain has no voice (TTS_PROVIDER); she'll be silent here");
      if (!w.hearing) ESP_LOGW(TAG, "the brain can't hear (STT_PROVIDER); the talk button is idle");
      break;
    }
    case BRAIN_MSG_STATE_SET: {
      rig_mode_t mode;
      protocol_state(msg, &mode);
      S.brain_mode = mode;
      if (mode == RIG_MODE_SPEAKING) S.ringing_until_ms = 0;
      break;
    }
    case BRAIN_MSG_EXPRESSION_SET: {
      proto_expression_t e;
      protocol_expression(msg, &e);
      S.affect = e.affect;
      S.intensity = e.intensity;
      S.brief_until_ms = 0;
      /* Her blend from the brain wins over the battery hint for this one. */
      rig_set_expression(&S.rig, e.affect, e.intensity, e.blend_affects, e.blend_weights,
                         e.blend_count);
      break;
    }
    case BRAIN_MSG_SPEECH_AUDIO_CHUNK: {
      proto_audio_chunk_t c;
      protocol_audio_chunk(msg, &c);
      if (!c.pcm16) break;
      size_t bytes = b64_decode(c.data, c.data_len, S.pcm_scratch);
      if (bytes == 0 && c.data_len > 0) {
        ESP_LOGW(TAG, "bad audio chunk %d", c.seq);
        break;
      }
      audio_out_push((const int16_t *)S.pcm_scratch, bytes / 2, c.sample_rate);
      break;
    }
    case BRAIN_MSG_SPEECH_CANCEL:
      audio_out_cancel();
      break;
    case BRAIN_MSG_TRANSCRIPT: {
      const char *text;
      protocol_transcript(msg, &text);
      if (*text) {
        ESP_LOGI(TAG, "she heard: %s", text);
        express_briefly(AFFECT_CURIOUS, 0.4f, 2000);
      } else {
        ESP_LOGI(TAG, "she didn't catch that");
        express_briefly(AFFECT_CONFUSED, 0.35f, 1500);
      }
      break;
    }
    case BRAIN_MSG_CAPABILITY_CALL: {
      proto_call_t call;
      protocol_capability_call(msg, &call);
      on_call(&call);
      break;
    }
    case BRAIN_MSG_ERROR: {
      proto_error_t err;
      protocol_error(msg, &err);
      if (strcmp(err.code, "llm_unavailable") == 0) express_briefly(AFFECT_CONCERNED, 0.6f, 4000);
      break;
    }
    default:
      break; /* captions and marks: nothing to show on this body */
  }
  xSemaphoreGive(S.lock);
}

static void on_status(link_status_t status, void *ctx) {
  (void)ctx;
  xSemaphoreTake(S.lock, portMAX_DELAY);
  bool was_online = S.link == LINK_ONLINE;
  S.link = status;
  if (status == LINK_ONLINE) {
    S.affect = AFFECT_NEUTRAL;
    S.intensity = 1;
    rig_hop(&S.rig, 0.8f);
    express_briefly(AFFECT_HAPPY, 0.6f, 1800);
  } else if (was_online) {
    S.brain_mode = RIG_MODE_IDLE;
    S.timer_count = 0;
    audio_out_cancel();
    audio_in_stop();
    S.affect = AFFECT_SLEEPY;
    S.intensity = 0.6f;
    S.brief_until_ms = 0;
    apply_expression();
  }
  xSemaphoreGive(S.lock);
}

/* ---------- the talk button ---------- */

static void on_press(void *ctx) {
  (void)ctx;
  xSemaphoreTake(S.lock, portMAX_DELAY);
  if (S.link != LINK_ONLINE) {
    express_briefly(AFFECT_CONFUSED, 0.3f, 1000);
    xSemaphoreGive(S.lock);
    return;
  }
  /* Talking over her: barge-in (ADR-0010). */
  if (S.brain_mode == RIG_MODE_THINKING || S.brain_mode == RIG_MODE_SPEAKING ||
      audio_out_busy()) {
    audio_out_cancel();
    brain_link_send(protocol_interrupt(brain_link_env()));
  }
  if (!S.brain_hears) {
    express_briefly(AFFECT_CONFUSED, 0.4f, 1200);
    xSemaphoreGive(S.lock);
    return;
  }
  xSemaphoreGive(S.lock);
  audio_in_start();
}

static void on_release(void *ctx) {
  (void)ctx;
  audio_in_stop();
}

static void on_chunk(const int16_t *pcm, size_t samples, int seq, void *ctx) {
  (void)ctx;
  size_t bytes = samples * sizeof(int16_t);
  char *b64 = heap_caps_malloc(b64_encoded_size(bytes), MALLOC_CAP_SPIRAM);
  if (!b64) return;
  b64_encode((const uint8_t *)pcm, bytes, b64);
  brain_link_send(protocol_audio_chunk_msg(brain_link_env(), seq, 16000, b64));
  free(b64);
}

static void on_end(int chunks, void *ctx) {
  (void)ctx;
  (void)chunks;
  brain_link_send(protocol_audio_end(brain_link_env()));
}

/* ---------- her face, frame by frame ---------- */

static void check_battery(int64_t now) {
  if (now - S.battery_checked_ms < BATTERY_CHECK_MS) return;
  S.battery_checked_ms = now;
  float volts;
  int percent;
  if (!battery_read(&volts, &percent)) return;
  bool low = percent < LOW_BATTERY_PERCENT;
  xSemaphoreTake(S.lock, portMAX_DELAY);
  if (low != S.low_battery) {
    S.low_battery = low;
    apply_expression();
    ESP_LOGI(TAG, "battery %.2f V (%d%%)%s", volts, percent, low ? ", sleepy" : "");
  }
  xSemaphoreGive(S.lock);
  if (brain_link_online() && now - S.battery_reported_ms >= BATTERY_REPORT_MS) {
    S.battery_reported_ms = now;
    cJSON *data = cJSON_CreateObject();
    cJSON_AddNumberToObject(data, "volts", volts);
    cJSON_AddNumberToObject(data, "percent", percent);
    brain_link_send(protocol_sensor(brain_link_env(), "battery", data));
  }
}

static void render_task(void *arg) {
  (void)arg;
  rig_frame_t frame;
  face_timer_t timer;
  face_status_t status;
  int64_t last = uptime_ms();
  for (;;) {
    int64_t now = uptime_ms();
    float dt = (float)(now - last) / 1000.0f;
    last = now;

    time_t t = time(NULL);
    struct tm tm;
    localtime_r(&t, &tm);
    bool synced = wifi_time_synced();

    xSemaphoreTake(S.lock, portMAX_DELAY);
    rig_viseme_t v;
    rig_set_viseme(&S.rig, audio_out_viseme(&v) ? &v : NULL);
    rig_set_mode(&S.rig, audio_in_capturing() ? RIG_MODE_LISTENING : S.brain_mode);
    if (S.brief_until_ms && now >= S.brief_until_ms) {
      S.brief_until_ms = 0;
      apply_expression();
    }

    memset(&timer, 0, sizeof timer);
    for (int i = 0; i < S.timer_count; i++) {
      shown_timer_t *s = &S.timers[i];
      if (!s->is_timer || s->duration_s <= 0) continue;
      int64_t left_ms = synced ? s->ends_at_ms - wall_ms() : 0;
      if (left_ms < 0) left_ms = 0;
      timer.active = true;
      timer.remaining = synced ? (float)left_ms / ((float)s->duration_s * 1000.0f) : 1;
      face_format_countdown((int)((left_ms + 999) / 1000), timer.readout);
      break;
    }
    if (now < S.ringing_until_ms) {
      timer.active = true;
      timer.ringing = true;
    }
    status.online = S.link == LINK_ONLINE;
    if (synced) {
      int h = tm.tm_hour % 12;
      snprintf(status.clock, sizeof status.clock, "%d:%02d", h ? h : 12, tm.tm_min);
    } else {
      status.clock[0] = '\0';
    }
    rig_update(&S.rig, dt, tm.tm_hour, tm.tm_min, tm.tm_sec, &frame);
    xSemaphoreGive(S.lock);

    face_draw(&S.fb, &S.mask, &frame, &timer, &status);
    display_flush(&S.fb);
    check_battery(now);

    int64_t spent = uptime_ms() - now;
    if (spent < FRAME_MS) vTaskDelay(pdMS_TO_TICKS(FRAME_MS - spent));
    else taskYIELD();
  }
}

void body_start(void) {
  S.lock = xSemaphoreCreateMutex();
  S.fb.w = FACE_W;
  S.fb.h = FACE_H;
  S.fb.px = heap_caps_malloc(FACE_W * FACE_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
  S.mask.w = FACE_W;
  S.mask.h = FACE_H;
  S.mask.a = heap_caps_calloc(FACE_W * FACE_H, 1, MALLOC_CAP_SPIRAM);
  S.mask.x0 = S.mask.w;
  S.mask.y0 = S.mask.h;
  S.mask.x1 = S.mask.y1 = -1;
  S.pcm_scratch = heap_caps_malloc(b64_decoded_cap(CONFIG_DESK_WS_MAX_MESSAGE_KB * 1024),
                                   MALLOC_CAP_SPIRAM);
  assert(S.fb.px && S.mask.a && S.pcm_scratch);

  rig_init(&S.rig, (uint32_t)esp_timer_get_time() | 1);
  S.affect = AFFECT_SLEEPY; /* asleep until the brain is here */
  S.intensity = 0.6f;
  apply_expression();
  S.link = LINK_OFFLINE;

  audio_in_init(on_chunk, on_end, NULL);
  button_init(on_press, on_release, NULL);
  xTaskCreatePinnedToCore(render_task, "face", 8192, NULL, 4, NULL, 1);
  ESP_LOGI(TAG, "her face is on");
}

void body_wifi_changed(bool connected) {
  if (connected && !S.link_started) {
    S.link_started = true;
    brain_link_handlers_t handlers = {on_message, on_status, NULL};
    brain_link_start(&handlers);
  }
}

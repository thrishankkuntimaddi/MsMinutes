#include "brain_link.h"

#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

static const char *TAG = "brain";

#define MAX_MESSAGE (CONFIG_DESK_WS_MAX_MESSAGE_KB * 1024)

/* Disabled Kconfig bools are undefined, not 0. */
#ifdef CONFIG_DESK_HAS_MIC
#define HAS_MIC true
#else
#define HAS_MIC false
#endif
#ifdef CONFIG_DESK_HAS_SPEAKER
#define HAS_SPEAKER true
#else
#define HAS_SPEAKER false
#endif
#define SEND_TIMEOUT_MS 2000

static esp_websocket_client_handle_t s_client;
static brain_link_handlers_t s_handlers;
static SemaphoreHandle_t s_send_lock;
static esp_timer_handle_t s_heartbeat;
static volatile bool s_online;
static char *s_buf; /* reassembly buffer for fragmented frames, in PSRAM */
static size_t s_len;
static bool s_dropping;

static uint64_t now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000 + (uint64_t)tv.tv_usec / 1000;
}

static void uuid4(char out[37]) {
  uint32_t r[4] = {esp_random(), esp_random(), esp_random(), esp_random()};
  snprintf(out, 37, "%08" PRIx32 "-%04" PRIx32 "-4%03" PRIx32 "-%04" PRIx32 "-%04" PRIx32 "%08" PRIx32,
           r[0], r[1] >> 16, r[1] & 0xFFF, ((r[2] >> 16) & 0x3FFF) | 0x8000, r[2] & 0xFFFF, r[3]);
}

static const proto_env_t s_env = {CONFIG_DESK_BODY_ID, now_ms, uuid4};

const proto_env_t *brain_link_env(void) { return &s_env; }

static void set_status(link_status_t status) {
  s_online = status == LINK_ONLINE;
  if (s_handlers.on_status) s_handlers.on_status(status, s_handlers.ctx);
}

bool brain_link_send(char *json) {
  if (!json) return false;
  bool ok = false;
  if (s_client && esp_websocket_client_is_connected(s_client)) {
    xSemaphoreTake(s_send_lock, portMAX_DELAY);
    int sent = esp_websocket_client_send_text(s_client, json, (int)strlen(json),
                                              pdMS_TO_TICKS(SEND_TIMEOUT_MS));
    xSemaphoreGive(s_send_lock);
    ok = sent >= 0;
    if (!ok) ESP_LOGW(TAG, "send failed");
  }
  free(json);
  return ok;
}

static void heartbeat(void *arg) {
  (void)arg;
  brain_link_send(protocol_heartbeat(&s_env));
}

static void handle_text(const char *text, size_t len) {
  brain_msg_t msg;
  proto_result_t r = protocol_parse(text, len, &msg);
  if (r == PROTO_OK && !protocol_validate(&msg)) r = PROTO_INVALID_MESSAGE;
  if (r != PROTO_OK) {
    ESP_LOGW(TAG, "ignored a message the brain sent (%d): %.80s", r, text);
    protocol_free(&msg);
    return;
  }
  if (msg.type == BRAIN_MSG_WELCOME) {
    proto_welcome_t w;
    protocol_welcome(&msg, &w);
    ESP_LOGI(TAG, "%s is here (session %s, audio %d, hearing %d)", w.persona_name, w.session_id,
             w.audio, w.hearing);
    esp_timer_stop(s_heartbeat);
    /* A little early, so a slow network never looks like silence. */
    ESP_ERROR_CHECK(esp_timer_start_periodic(s_heartbeat, (uint64_t)w.heartbeat_interval_ms * 800));
    set_status(LINK_ONLINE);
  } else if (msg.type == BRAIN_MSG_ERROR) {
    proto_error_t err;
    protocol_error(&msg, &err);
    ESP_LOGW(TAG, "brain error %s: %s%s", err.code, err.message, err.fatal ? " (fatal)" : "");
  }
  if (s_handlers.on_message) s_handlers.on_message(&msg, s_handlers.ctx);
  protocol_free(&msg);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)base;
  esp_websocket_event_data_t *e = data;
  switch (id) {
    case WEBSOCKET_EVENT_BEFORE_CONNECT:
      set_status(LINK_CONNECTING);
      break;
    case WEBSOCKET_EVENT_CONNECTED:
      ESP_LOGI(TAG, "connected to %s as %s", CONFIG_DESK_BRAIN_URL, CONFIG_DESK_BODY_ID);
      s_len = 0;
      s_dropping = false;
      brain_link_send(protocol_hello(&s_env, BODY_TYPE, FIRMWARE_VERSION, HAS_MIC, HAS_SPEAKER));
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
    case WEBSOCKET_EVENT_ERROR:
      if (s_online || id != WEBSOCKET_EVENT_ERROR) ESP_LOGW(TAG, "link down (%" PRId32 ")", id);
      esp_timer_stop(s_heartbeat);
      set_status(LINK_OFFLINE);
      break;
    case WEBSOCKET_EVENT_DATA: {
      /* Text frames only; a frame may arrive in pieces of up to buffer_size. */
      if (e->op_code != 0x1 && e->op_code != 0x0) break;
      if (e->payload_offset == 0) {
        s_len = 0;
        s_dropping = e->payload_len > MAX_MESSAGE;
        if (s_dropping) ESP_LOGW(TAG, "frame of %d bytes is too big; dropped", e->payload_len);
      }
      if (s_dropping || e->data_len <= 0) break;
      if (s_len + (size_t)e->data_len > (size_t)MAX_MESSAGE) {
        s_dropping = true;
        break;
      }
      memcpy(s_buf + s_len, e->data_ptr, (size_t)e->data_len);
      s_len += (size_t)e->data_len;
      if (e->payload_offset + e->data_len >= e->payload_len) {
        s_buf[s_len] = '\0';
        handle_text(s_buf, s_len);
        s_len = 0;
      }
      break;
    }
    default:
      break;
  }
}

void brain_link_start(const brain_link_handlers_t *handlers) {
  s_handlers = *handlers;
  s_send_lock = xSemaphoreCreateMutex();
  s_buf = heap_caps_malloc(MAX_MESSAGE + 1, MALLOC_CAP_SPIRAM);
  assert(s_buf);
  esp_timer_create_args_t timer = {.callback = heartbeat, .arg = NULL, .name = "heartbeat"};
  ESP_ERROR_CHECK(esp_timer_create(&timer, &s_heartbeat));

  esp_websocket_client_config_t config = {
      .uri = CONFIG_DESK_BRAIN_URL,
      .buffer_size = 16 * 1024,
      .reconnect_timeout_ms = 3000,
      .network_timeout_ms = 10000,
      .ping_interval_sec = 20,
      .task_stack = 8192,
      .task_prio = 5,
  };
  s_client = esp_websocket_client_init(&config);
  assert(s_client);
  ESP_ERROR_CHECK(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, on_event, NULL));
  ESP_ERROR_CHECK(esp_websocket_client_start(s_client));
}

bool brain_link_online(void) { return s_online; }

#include "audio_out.h"

#include <math.h>
#include <assert.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_DESK_HAS_SPEAKER
#include "driver/i2s_std.h"
#endif

static const char *TAG = "voice";

/* 20 s of 24 kHz PCM16 in PSRAM: several sentences ahead of what's playing. */
#define RING_SAMPLES (24000 * 20)
#define BLOCK_SAMPLES 480 /* 20 ms at 24 kHz */
#define MAX_CHUNKS 64

typedef struct {
  size_t samples;
  int sample_rate;
  uint32_t generation;
} chunk_t;

static int16_t *s_ring;
static size_t s_head, s_tail; /* producer writes at head, player reads at tail */
static SemaphoreHandle_t s_lock;
static QueueHandle_t s_chunks;
static volatile uint32_t s_generation;
static volatile bool s_busy;
static volatile float s_level, s_bright;
#if CONFIG_DESK_HAS_SPEAKER
static i2s_chan_handle_t s_tx;
static int s_rate;
#endif

static size_t ring_available(void) { return (s_head + RING_SAMPLES - s_tail) % RING_SAMPLES; }
static size_t ring_free(void) { return RING_SAMPLES - 1 - ring_available(); }

static size_t ring_read(int16_t *out, size_t max) {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  size_t n = ring_available();
  if (n > max) n = max;
  for (size_t i = 0; i < n; i++) out[i] = s_ring[(s_tail + i) % RING_SAMPLES];
  s_tail = (s_tail + n) % RING_SAMPLES;
  xSemaphoreGive(s_lock);
  return n;
}

#if CONFIG_DESK_HAS_SPEAKER
static void set_rate(int rate) {
  if (rate == s_rate) return;
  i2s_channel_disable(s_tx);
  i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG((uint32_t)rate);
  ESP_ERROR_CHECK(i2s_channel_reconfig_std_clock(s_tx, &clk));
  ESP_ERROR_CHECK(i2s_channel_enable(s_tx));
  s_rate = rate;
}
#endif

/* Fast attack, slower release, like a real jaw (apps/web-body AudioVoice.sample). */
static void analyse(const int16_t *pcm, size_t n) {
  float sum = 0;
  int crossings = 0;
  for (size_t i = 0; i < n; i++) {
    float v = (float)pcm[i] / 32768.0f;
    sum += v * v;
    if (i && ((pcm[i] < 0) != (pcm[i - 1] < 0))) crossings++;
  }
  float rms = sqrtf(sum / (float)(n ? n : 1));
  float target = fminf(1, fmaxf(0, (rms - 0.012f) * 7));
  s_level += (target - s_level) * (target > s_level ? 0.6f : 0.25f);
  s_bright = fminf(1, (float)crossings / ((float)n * 0.18f));
}

static void player_task(void *arg) {
  (void)arg;
  static int16_t block[BLOCK_SAMPLES];
  chunk_t chunk;
  for (;;) {
    if (xQueueReceive(s_chunks, &chunk, pdMS_TO_TICKS(100)) != pdTRUE) {
      if (s_busy) {
        s_busy = false;
        s_level = 0;
      }
      continue;
    }
    if (chunk.generation != s_generation) continue;
#if CONFIG_DESK_HAS_SPEAKER
    set_rate(chunk.sample_rate);
#endif
    s_busy = true;
    size_t left = chunk.samples;
    while (left > 0 && chunk.generation == s_generation) {
      size_t want = left < BLOCK_SAMPLES ? left : BLOCK_SAMPLES;
      size_t got = ring_read(block, want);
      if (got == 0) break; /* cancelled under us */
      analyse(block, got);
#if CONFIG_DESK_HAS_SPEAKER
      size_t written = 0;
      i2s_channel_write(s_tx, block, got * sizeof(int16_t), &written, pdMS_TO_TICKS(500));
#else
      vTaskDelay(pdMS_TO_TICKS(got * 1000 / (size_t)chunk.sample_rate));
#endif
      left -= got;
    }
  }
}

void audio_out_init(void) {
  s_ring = heap_caps_malloc(RING_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
  assert(s_ring);
  s_lock = xSemaphoreCreateMutex();
  s_chunks = xQueueCreate(MAX_CHUNKS, sizeof(chunk_t));
#if CONFIG_DESK_HAS_SPEAKER
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
  chan.auto_clear = true;
  ESP_ERROR_CHECK(i2s_new_channel(&chan, &s_tx, NULL));
  i2s_std_config_t std = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(24000),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = CONFIG_DESK_PIN_AMP_BCLK,
              .ws = CONFIG_DESK_PIN_AMP_WS,
              .dout = CONFIG_DESK_PIN_AMP_DOUT,
              .din = I2S_GPIO_UNUSED,
              .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
          },
  };
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_tx, &std));
  ESP_ERROR_CHECK(i2s_channel_enable(s_tx));
  s_rate = 24000;
  ESP_LOGI(TAG, "speaker ready (I2S TX)");
#else
  ESP_LOGW(TAG, "built without a speaker; her voice is timed but silent");
#endif
  xTaskCreatePinnedToCore(player_task, "voice", 4096, NULL, 7, NULL, 1);
}

void audio_out_push(const int16_t *pcm, size_t samples, int sample_rate) {
  if (samples == 0) return;
  xSemaphoreTake(s_lock, portMAX_DELAY);
  if (ring_free() < samples) {
    xSemaphoreGive(s_lock);
    ESP_LOGW(TAG, "voice buffer full; dropped %u samples", (unsigned)samples);
    return;
  }
  for (size_t i = 0; i < samples; i++) s_ring[(s_head + i) % RING_SAMPLES] = pcm[i];
  s_head = (s_head + samples) % RING_SAMPLES;
  chunk_t chunk = {samples, sample_rate, s_generation};
  xSemaphoreGive(s_lock);
  if (xQueueSend(s_chunks, &chunk, pdMS_TO_TICKS(100)) != pdTRUE) {
    ESP_LOGW(TAG, "too many chunks queued; dropped one");
  }
}

void audio_out_cancel(void) {
  xSemaphoreTake(s_lock, portMAX_DELAY);
  s_generation++;
  xQueueReset(s_chunks);
  s_tail = s_head;
  xSemaphoreGive(s_lock);
  s_busy = false;
  s_level = 0;
}

bool audio_out_busy(void) { return s_busy; }

bool audio_out_viseme(rig_viseme_t *out) {
  if (!s_busy) return false;
  float level = s_level, bright = s_bright;
  out->open = level * 0.9f;
  /* Hissy sounds (s, f, t) cross zero often: flatter, wider mouth. Dark vowels: rounder. */
  out->round = fmaxf(0, 0.45f - bright) * level * 1.4f;
  out->width = 0.9f + bright * 0.25f;
  return true;
}

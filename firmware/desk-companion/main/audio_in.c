#include "audio_in.h"

#include <assert.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_DESK_HAS_MIC
#include "driver/i2s_std.h"
#endif

static const char *TAG = "ears";

#define RATE 16000
#define CHUNK_SAMPLES RATE /* one second per event.audio.chunk, as the browser body sends */
#define PIECE_SAMPLES (RATE / 10)

static audio_in_chunk_cb s_on_chunk;
static audio_in_end_cb s_on_end;
static void *s_ctx;
static volatile bool s_capturing;
static TaskHandle_t s_task;
static int16_t *s_chunk;
#if CONFIG_DESK_HAS_MIC
static i2s_chan_handle_t s_rx;
static int32_t *s_raw;
#endif

static void capture_task(void *arg) {
  (void)arg;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (!s_capturing) continue;
    int seq = 0;
    size_t filled = 0;
    const size_t limit = (size_t)CONFIG_DESK_MAX_UTTERANCE_S * RATE;
    size_t total = 0;
#if CONFIG_DESK_HAS_MIC
    ESP_ERROR_CHECK(i2s_channel_enable(s_rx));
#endif
    while (s_capturing && total < limit) {
      size_t got = 0;
#if CONFIG_DESK_HAS_MIC
      size_t bytes = 0;
      if (i2s_channel_read(s_rx, s_raw, PIECE_SAMPLES * sizeof(int32_t), &bytes,
                           pdMS_TO_TICKS(200)) != ESP_OK) {
        continue;
      }
      got = bytes / sizeof(int32_t);
      for (size_t i = 0; i < got && filled + i < CHUNK_SAMPLES; i++) {
        /* 24-bit left-justified in 32 bits → 16-bit, with a little gain. */
        int32_t v = s_raw[i] >> CONFIG_DESK_MIC_GAIN_SHIFT;
        s_chunk[filled + i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
      }
#else
      vTaskDelay(pdMS_TO_TICKS(100));
      got = PIECE_SAMPLES;
      memset(&s_chunk[filled], 0, got * sizeof(int16_t));
#endif
      filled += got;
      total += got;
      if (filled >= CHUNK_SAMPLES) {
        if (s_on_chunk) s_on_chunk(s_chunk, CHUNK_SAMPLES, seq++, s_ctx);
        filled = 0;
      }
    }
#if CONFIG_DESK_HAS_MIC
    i2s_channel_disable(s_rx);
#endif
    if (filled > 0 && s_on_chunk) s_on_chunk(s_chunk, filled, seq++, s_ctx);
    s_capturing = false;
    if (s_on_end) s_on_end(seq, s_ctx);
    ESP_LOGI(TAG, "heard %.1f s", (float)total / RATE);
  }
}

void audio_in_init(audio_in_chunk_cb on_chunk, audio_in_end_cb on_end, void *ctx) {
  s_on_chunk = on_chunk;
  s_on_end = on_end;
  s_ctx = ctx;
  s_chunk = heap_caps_malloc(CHUNK_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
  assert(s_chunk);
#if CONFIG_DESK_HAS_MIC
  s_raw = heap_caps_malloc(PIECE_SAMPLES * sizeof(int32_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
  assert(s_raw);
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
  ESP_ERROR_CHECK(i2s_new_channel(&chan, NULL, &s_rx));
  i2s_std_config_t std = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = CONFIG_DESK_PIN_MIC_BCLK,
              .ws = CONFIG_DESK_PIN_MIC_WS,
              .dout = I2S_GPIO_UNUSED,
              .din = CONFIG_DESK_PIN_MIC_DIN,
              .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
          },
  };
  /* INMP441 with L/R tied to ground speaks on the left slot. */
  std.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_rx, &std));
  ESP_LOGI(TAG, "microphone ready (I2S RX, %d Hz)", RATE);
#else
  ESP_LOGW(TAG, "built without a microphone; push-to-talk sends silence");
#endif
  xTaskCreatePinnedToCore(capture_task, "ears", 4096, NULL, 6, &s_task, 1);
}

void audio_in_start(void) {
  if (s_capturing) return;
  s_capturing = true;
  xTaskNotifyGive(s_task);
}

void audio_in_stop(void) { s_capturing = false; }

bool audio_in_capturing(void) { return s_capturing; }

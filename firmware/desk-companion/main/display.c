#include "display.h"

#include <assert.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_gc9a01.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

static const char *TAG = "display";

#define LCD_W 240
#define LCD_H 240
/* Rows per SPI transfer: 240 × 20 × 2 bytes = 9.6 KB of DMA-capable internal RAM. */
#define BAND_ROWS 20

static esp_lcd_panel_handle_t s_panel;
static uint16_t *s_band;
static SemaphoreHandle_t s_done;

static bool on_trans_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata,
                          void *ctx) {
  (void)io;
  (void)edata;
  (void)ctx;
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(s_done, &woken);
  return woken == pdTRUE;
}

static void backlight_init(void) {
  if (CONFIG_DESK_PIN_LCD_BL < 0) return;
  ledc_timer_config_t timer = {
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .duty_resolution = LEDC_TIMER_10_BIT,
      .timer_num = LEDC_TIMER_0,
      .freq_hz = 5000,
      .clk_cfg = LEDC_AUTO_CLK,
  };
  ESP_ERROR_CHECK(ledc_timer_config(&timer));
  ledc_channel_config_t channel = {
      .gpio_num = CONFIG_DESK_PIN_LCD_BL,
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .channel = LEDC_CHANNEL_0,
      .timer_sel = LEDC_TIMER_0,
      .duty = 0,
      .hpoint = 0,
  };
  ESP_ERROR_CHECK(ledc_channel_config(&channel));
}

void display_set_brightness(int percent) {
  if (CONFIG_DESK_PIN_LCD_BL < 0) return;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  uint32_t duty = (uint32_t)(1023 * percent / 100);
  ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

void display_init(void) {
  s_done = xSemaphoreCreateBinary();
  s_band = heap_caps_malloc(LCD_W * BAND_ROWS * sizeof(uint16_t), MALLOC_CAP_DMA);
  assert(s_band);

  spi_bus_config_t bus = {
      .sclk_io_num = CONFIG_DESK_PIN_LCD_SCLK,
      .mosi_io_num = CONFIG_DESK_PIN_LCD_MOSI,
      .miso_io_num = -1,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = LCD_W * BAND_ROWS * sizeof(uint16_t),
  };
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

  esp_lcd_panel_io_handle_t io;
  esp_lcd_panel_io_spi_config_t io_config = {
      .dc_gpio_num = CONFIG_DESK_PIN_LCD_DC,
      .cs_gpio_num = CONFIG_DESK_PIN_LCD_CS,
      .pclk_hz = CONFIG_DESK_LCD_SPI_HZ,
      .lcd_cmd_bits = 8,
      .lcd_param_bits = 8,
      .spi_mode = 0,
      .trans_queue_depth = 4,
      .on_color_trans_done = on_trans_done,
      .user_ctx = NULL,
  };
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_config, &io));

  esp_lcd_panel_dev_config_t panel_config = {
      .reset_gpio_num = CONFIG_DESK_PIN_LCD_RST,
      .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
      .bits_per_pixel = 16,
  };
  ESP_ERROR_CHECK(esp_lcd_new_panel_gc9a01(io, &panel_config, &s_panel));
  ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
  ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
#ifdef CONFIG_DESK_LCD_INVERT
  ESP_ERROR_CHECK(esp_lcd_panel_invert_color(s_panel, true));
#endif
  ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));

  backlight_init();
  display_set_brightness(CONFIG_DESK_BRIGHTNESS);
  ESP_LOGI(TAG, "GC9A01 up at %d MHz", CONFIG_DESK_LCD_SPI_HZ / 1000000);
}

void display_flush(const gfx_fb_t *fb) {
  for (int y = 0; y < LCD_H; y += BAND_ROWS) {
    const uint16_t *src = &fb->px[y * LCD_W];
    /* The panel wants big-endian RGB565; the framebuffer is native (little-endian). */
    for (int i = 0; i < LCD_W * BAND_ROWS; i++) s_band[i] = __builtin_bswap16(src[i]);
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, 0, y, LCD_W, y + BAND_ROWS, s_band));
    xSemaphoreTake(s_done, pdMS_TO_TICKS(200));
  }
}

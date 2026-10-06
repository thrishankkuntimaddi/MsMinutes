/*
 * Ms. Minutes desk companion: a thin client (ARCHITECTURE §15). It renders her face, captures
 * and plays audio, and speaks the Body Protocol. The brain does all the thinking.
 */
#include "app.h"
#include "audio_out.h"
#include "battery.h"
#include "body.h"
#include "display.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "nvs_flash.h"
#include "wifi.h"

static const char *TAG = "desk";

static void on_wifi(bool connected, void *ctx) {
  (void)ctx;
  body_wifi_changed(connected);
}

void app_main(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  ESP_LOGI(TAG, "firmware %s, PSRAM %u KB", FIRMWARE_VERSION,
           (unsigned)(esp_psram_get_size() / 1024));

  display_init();
  audio_out_init();
  battery_init();
  body_start();
  wifi_start(on_wifi, NULL);
}

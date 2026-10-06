idf_component_register(
  SRCS main.c wifi.c brain_link.c body.c display.c audio_out.c audio_in.c button.c battery.c
  INCLUDE_DIRS "."
  REQUIRES core driver esp_adc esp_event esp_hw_support esp_lcd esp_netif esp_psram esp_timer
           esp_wifi json lwip nvs_flash)

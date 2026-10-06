#include "battery.h"

#include "esp_log.h"
#include "sdkconfig.h"

#if CONFIG_DESK_HAS_BATTERY
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"

static const char *TAG = "battery";
static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;

void battery_init(void) {
  adc_oneshot_unit_init_cfg_t unit = {.unit_id = ADC_UNIT_1};
  ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit, &s_adc));
  adc_oneshot_chan_cfg_t chan = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
  ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, CONFIG_DESK_BATTERY_ADC_CHANNEL, &chan));
  adc_cali_curve_fitting_config_t cali = {
      .unit_id = ADC_UNIT_1,
      .chan = CONFIG_DESK_BATTERY_ADC_CHANNEL,
      .atten = ADC_ATTEN_DB_12,
      .bitwidth = ADC_BITWIDTH_DEFAULT,
  };
  if (adc_cali_create_scheme_curve_fitting(&cali, &s_cali) != ESP_OK) {
    ESP_LOGW(TAG, "no ADC calibration; readings will be rough");
    s_cali = NULL;
  }
}

bool battery_read(float *volts, int *percent) {
  int raw = 0, mv = 0;
  if (adc_oneshot_read(s_adc, CONFIG_DESK_BATTERY_ADC_CHANNEL, &raw) != ESP_OK) return false;
  if (s_cali) {
    adc_cali_raw_to_voltage(s_cali, raw, &mv);
  } else {
    mv = raw * 3100 / 4095; /* 12 dB attenuation spans roughly 0–3.1 V */
  }
  float v = (float)mv / 1000.0f * (float)CONFIG_DESK_BATTERY_DIVIDER / 100.0f;
  /* A LiPo's discharge curve, roughly: 4.2 V full, 3.5 V nearly empty. */
  float p = (v - 3.5f) / (4.2f - 3.5f) * 100.0f;
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  *volts = v;
  *percent = (int)p;
  return true;
}
#else
void battery_init(void) {}
bool battery_read(float *volts, int *percent) {
  (void)volts;
  (void)percent;
  return false;
}
#endif

#include "button.h"

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static button_cb s_press, s_release;
static void *s_ctx;

static void button_task(void *arg) {
  (void)arg;
  int stable = 1, last = 1, same = 0;
  for (;;) {
    int level = gpio_get_level(CONFIG_DESK_PIN_BUTTON);
    same = level == last ? same + 1 : 0;
    last = level;
    /* 30 ms steady before it counts. */
    if (same >= 3 && level != stable) {
      stable = level;
      if (stable == 0 && s_press) s_press(s_ctx);
      if (stable == 1 && s_release) s_release(s_ctx);
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void button_init(button_cb on_press, button_cb on_release, void *ctx) {
  s_press = on_press;
  s_release = on_release;
  s_ctx = ctx;
  gpio_config_t io = {
      .pin_bit_mask = 1ULL << CONFIG_DESK_PIN_BUTTON,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  ESP_ERROR_CHECK(gpio_config(&io));
  xTaskCreate(button_task, "button", 2048, NULL, 6, NULL);
}

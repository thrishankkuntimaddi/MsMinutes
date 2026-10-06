#include "wifi.h"

#include <string.h>
#include <time.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"
#include "esp_wifi.h"
#include "sdkconfig.h"

static const char *TAG = "wifi";
static wifi_change_cb s_on_change;
static void *s_ctx;
static volatile bool s_connected;
static bool s_sntp_started;

static void on_time_synced(struct timeval *tv) {
  (void)tv;
  ESP_LOGI(TAG, "clock set from %s", CONFIG_DESK_NTP_SERVER);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    bool was = s_connected;
    s_connected = false;
    ESP_LOGW(TAG, "disconnected from %s; retrying", CONFIG_DESK_WIFI_SSID);
    if (was && s_on_change) s_on_change(false, s_ctx);
    esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = data;
    ESP_LOGI(TAG, "connected, ip " IPSTR, IP2STR(&e->ip_info.ip));
    s_connected = true;
    if (!s_sntp_started) {
      s_sntp_started = true;
      esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_DESK_NTP_SERVER);
      config.sync_cb = on_time_synced;
      esp_netif_sntp_init(&config);
    }
    if (s_on_change) s_on_change(true, s_ctx);
  }
}

void wifi_start(wifi_change_cb on_change, void *ctx) {
  s_on_change = on_change;
  s_ctx = ctx;
  setenv("TZ", CONFIG_DESK_TZ, 1);
  tzset();

  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

  wifi_config_t config = {0};
  strncpy((char *)config.sta.ssid, CONFIG_DESK_WIFI_SSID, sizeof config.sta.ssid - 1);
  strncpy((char *)config.sta.password, CONFIG_DESK_WIFI_PASSWORD, sizeof config.sta.password - 1);
  config.sta.threshold.authmode = strlen(CONFIG_DESK_WIFI_PASSWORD) ? WIFI_AUTH_WPA2_PSK
                                                                    : WIFI_AUTH_OPEN;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
  ESP_ERROR_CHECK(esp_wifi_start());
  ESP_LOGI(TAG, "joining %s", CONFIG_DESK_WIFI_SSID);
}

bool wifi_connected(void) { return s_connected; }

bool wifi_time_synced(void) {
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  return tm.tm_year + 1900 >= 2024;
}

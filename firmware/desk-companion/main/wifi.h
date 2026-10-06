#pragma once

#include <stdbool.h>

typedef void (*wifi_change_cb)(bool connected, void *ctx);

/* Joins the configured network as a station and keeps rejoining; then syncs the clock. */
void wifi_start(wifi_change_cb on_change, void *ctx);
bool wifi_connected(void);
/* True once SNTP has set the wall clock. */
bool wifi_time_synced(void);

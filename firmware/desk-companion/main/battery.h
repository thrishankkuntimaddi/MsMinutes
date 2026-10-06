#pragma once

#include <stdbool.h>

void battery_init(void);
/* False when there is no battery sense; `percent` is a rough LiPo estimate from voltage. */
bool battery_read(float *volts, int *percent);

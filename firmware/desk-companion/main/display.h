#pragma once

#include <stdint.h>

#include "gfx.h"

/* Brings up the GC9A01 over SPI with DMA and the backlight. */
void display_init(void);
/* Sends a whole frame; blocks until it's on the panel (~25 ms at 40 MHz). */
void display_flush(const gfx_fb_t *fb);
void display_set_brightness(int percent);

/* Writes an RGB565 framebuffer as an uncompressed PNG (stored deflate), for the pose sheet. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

bool png_write_rgb565(const char *path, int w, int h, const uint16_t *px);

/*
 * Draws Ms. Minutes' clock face from a rig frame onto a 240×240 RGB565 framebuffer: the
 * round display is her case, so this is apps/web-body's `#face()` at device scale, plus a
 * small dial window (a watch's date window) that shows the time, a countdown, or OFF.
 */
#pragma once

#include <stdbool.h>

#include "gfx.h"
#include "rig.h"

#define FACE_W 240
#define FACE_H 240

typedef struct {
  bool active;      /* a timer is running */
  float remaining;  /* 0..1 of its duration left */
  bool ringing;     /* it just went off: flash until she has said so */
  char readout[8];  /* what the dial window shows while active, e.g. "4:59" */
} face_timer_t;

typedef struct {
  bool online;   /* connected to the brain; otherwise the window reads OFF */
  char clock[8]; /* local time for the window, e.g. "12:05"; "" when unknown */
} face_status_t;

/* `scratch` is a FACE_W×FACE_H coverage mask the renderer reuses for clipping. */
void face_draw(gfx_fb_t *fb, gfx_mask_t *scratch, const rig_frame_t *f,
               const face_timer_t *timer, const face_status_t *status);

/* Formats seconds as m:ss (or h:mm past an hour) into a dial-window readout. */
void face_format_countdown(int seconds, char out[8]);

/* Draws her pose sheet: every affect, her modes, a timer, ringing and offline. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "face.h"
#include "png.h"
#include "rig.h"

#define COLS 5
#define ROWS 4

typedef struct {
  const char *label;
  int affect;
  rig_mode_t mode;
  bool timer, ringing, offline, speaking;
} pose_t;

static void render_tile(uint16_t *sheet, int col, int row, const pose_t *pose) {
  static uint16_t tile[FACE_W * FACE_H];
  static uint8_t mask_px[FACE_W * FACE_H];
  gfx_fb_t fb = {FACE_W, FACE_H, tile};
  gfx_mask_t mask = {FACE_W, FACE_H, mask_px, 0, 0, FACE_W - 1, FACE_H - 1};
  gfx_mask_clear(&mask);

  rig_t rig;
  rig_init(&rig, 7);
  rig_set_expression(&rig, pose->affect, 1, NULL, NULL, 0);
  rig_set_mode(&rig, pose->mode);
  rig_viseme_t v = {0.6f, 0.1f, 1.05f};
  if (pose->speaking) rig_set_viseme(&rig, &v);
  rig_frame_t f;
  /* Let the springs settle, past the first idle blink. */
  for (int i = 0; i < 90; i++) rig_update(&rig, 1.0f / 60, 10, 8, 30, &f);
  if (pose->ringing) {
    rig_ring(&rig, 1);
    rig_update(&rig, 1.0f / 60, 10, 8, 30, &f);
  }
  face_timer_t timer = {.active = pose->timer || pose->ringing, .remaining = 0.62f,
                        .ringing = pose->ringing};
  face_format_countdown(149, timer.readout);
  face_status_t status = {.online = !pose->offline, .clock = "10:08"};
  face_draw(&fb, &mask, &f, &timer, &status);

  for (int y = 0; y < FACE_H; y++) {
    memcpy(&sheet[(row * FACE_H + y) * (COLS * FACE_W) + col * FACE_W], &tile[y * FACE_W],
           FACE_W * sizeof(uint16_t));
  }
}

int main(int argc, char **argv) {
  const char *out = argc > 1 ? argv[1] : "poses.png";
  pose_t poses[COLS * ROWS];
  int n = 0;
  for (int a = 0; a < RIG_AFFECT_COUNT; a++) {
    poses[n++] = (pose_t){RIG_AFFECT_NAMES[a], a, RIG_MODE_IDLE, false, false, false, false};
  }
  poses[n++] = (pose_t){"listening", AFFECT_NEUTRAL, RIG_MODE_LISTENING, false, false, false, false};
  poses[n++] = (pose_t){"speaking", AFFECT_HAPPY, RIG_MODE_SPEAKING, false, false, false, true};
  poses[n++] = (pose_t){"timer", AFFECT_NEUTRAL, RIG_MODE_TIMER_RUNNING, true, false, false, false};
  poses[n++] = (pose_t){"ringing", AFFECT_EXCITED, RIG_MODE_IDLE, true, true, false, false};
  poses[n++] = (pose_t){"offline", AFFECT_SLEEPY, RIG_MODE_IDLE, false, false, true, false};

  uint16_t *sheet = calloc((size_t)COLS * FACE_W * ROWS * FACE_H, sizeof(uint16_t));
  if (!sheet) return 1;
  for (int i = 0; i < n; i++) {
    render_tile(sheet, i % COLS, i / COLS, &poses[i]);
    printf("%-10s", poses[i].label);
    if (i % COLS == COLS - 1) printf("\n");
  }
  printf("\n");
  bool ok = png_write_rgb565(out, COLS * FACE_W, ROWS * FACE_H, sheet);
  free(sheet);
  if (!ok) {
    fprintf(stderr, "couldn't write %s\n", out);
    return 1;
  }
  printf("wrote %s\n", out);
  return 0;
}

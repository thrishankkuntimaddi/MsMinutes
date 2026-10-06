/*
 * Her face's brain-stem, ported from packages/character (rig.ts): springs, presets, modes,
 * blinks, gaze and breath. Pure C, no ESP-IDF, so it builds on the host too.
 *
 * Not ported: Motion (walking, jumping, arms). On the desk companion the round display is
 * her clock face, so the body is never in view and the brain gets no `animate` capability.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "rig_presets.h"

typedef enum {
  RIG_MODE_IDLE = 0,
  RIG_MODE_LISTENING,
  RIG_MODE_THINKING,
  RIG_MODE_SPEAKING,
  RIG_MODE_TIMER_RUNNING,
} rig_mode_t;

/* Mouth shape for one sound: 0..1 open, 0..1 round, width factor around 1. */
typedef struct {
  float open, round, width;
} rig_viseme_t;

typedef struct {
  float value, velocity, target, stiffness, damping;
} rig_spring_t;

typedef enum { RIG_EYE_BOTH = 0, RIG_EYE_LEFT, RIG_EYE_RIGHT } rig_eye_t;

typedef struct {
  float start;
  rig_eye_t eye;
  float close, hold, open;
} rig_blink_t;

#define RIG_MAX_BLINKS 6

/* Everything the renderer needs for one frame. */
typedef struct {
  float p[RIG_PARAM_COUNT]; /* indexed by enum rig_param */
  float blink_l, blink_r;   /* 0 open → 1 closed */
  float ring;               /* 0..1 how hard the alarm bells are ringing */
  float hour_angle, minute_angle; /* radians, 0 = 12 o'clock */
  float t;                        /* seconds since the rig started */
} rig_frame_t;

typedef struct {
  rig_spring_t springs[RIG_PARAM_COUNT];
  float targets[RIG_PARAM_COUNT];
  float laugh;
  rig_mode_t mode;
  int affect;
  bool has_viseme;
  rig_viseme_t viseme;
  float t;
  rig_blink_t blinks[RIG_MAX_BLINKS];
  int blink_count;
  float next_blink;
  float gaze_x, gaze_y, next_saccade;
  bool looking;
  float look_x, look_y, look_until;
  float ring_until, ring, spin;
  uint32_t rng;
} rig_t;

void rig_spring_init(rig_spring_t *s, float value, float stiffness, float damping_ratio);
float rig_spring_step(rig_spring_t *s, float dt);

void rig_init(rig_t *rig, uint32_t seed);
/* -1 when the name isn't one of hers. */
int rig_affect_from_name(const char *name);
/* `blend` entries are secondary affects on top, e.g. happy + a little sleepy. */
void rig_set_expression(rig_t *rig, int affect, float intensity, const int *blend_affects,
                        const float *blend_weights, int blend_count);
void rig_set_mode(rig_t *rig, rig_mode_t mode);
/* NULL when she isn't speaking. */
void rig_set_viseme(rig_t *rig, const rig_viseme_t *viseme);
void rig_blink(rig_t *rig, rig_eye_t eye);
void rig_wink(rig_t *rig, rig_eye_t eye, float hold_seconds);
void rig_ring(rig_t *rig, float seconds);
/* A little jump: up, then squash on landing. */
void rig_hop(rig_t *rig, float strength);
void rig_look_at(rig_t *rig, float x, float y, float hold_seconds);
/* Advances by dt seconds; `hours`/`minutes`/`seconds` is the local wall clock for her hands. */
void rig_update(rig_t *rig, float dt, int hours, int minutes, int seconds, rig_frame_t *out);

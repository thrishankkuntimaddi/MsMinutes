#include "rig.h"

#include <math.h>
#include <string.h>

#define TAU 6.28318530718f
/* Longest spring integration step, in seconds (rig.ts MAX_STEP). */
#define MAX_STEP (1.0f / 120.0f)

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
static float lerpf(float a, float b, float t) { return a + (b - a) * t; }
static float ease_in(float x) { return x * x; }
static float ease_out(float x) { return 1 - (1 - x) * (1 - x); }

/* xorshift32: deterministic idle life when seeded the same. */
static float rnd(rig_t *rig) {
  uint32_t x = rig->rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  rig->rng = x ? x : 0x9e3779b9u;
  return (float)(x >> 8) / 16777216.0f;
}

void rig_spring_init(rig_spring_t *s, float value, float stiffness, float damping_ratio) {
  s->value = value;
  s->target = value;
  s->velocity = 0;
  s->stiffness = stiffness;
  s->damping = 2 * damping_ratio * sqrtf(stiffness);
}

float rig_spring_step(rig_spring_t *s, float dt) {
  int steps = (int)ceilf(dt / MAX_STEP);
  if (steps < 1) steps = 1;
  float h = dt / (float)steps;
  for (int i = 0; i < steps; i++) {
    float accel = s->stiffness * (s->target - s->value) - s->damping * s->velocity;
    s->velocity += accel * h;
    s->value += s->velocity * h;
  }
  return s->value;
}

void rig_init(rig_t *rig, uint32_t seed) {
  memset(rig, 0, sizeof(*rig));
  rig->rng = seed ? seed : 1;
  for (int i = 0; i < RIG_PARAM_COUNT; i++) {
    rig_spring_init(&rig->springs[i], RIG_NEUTRAL[i], RIG_TUNING[i][0], RIG_TUNING[i][1]);
    rig->targets[i] = RIG_NEUTRAL[i];
  }
  rig->affect = AFFECT_NEUTRAL;
  rig->next_blink = 1.2f;
  rig->next_saccade = 0.8f;
  rig->ring_until = -1;
}

int rig_affect_from_name(const char *name) {
  if (!name) return -1;
  for (int i = 0; i < RIG_AFFECT_COUNT; i++) {
    if (strcmp(RIG_AFFECT_NAMES[i], name) == 0) return i;
  }
  return -1;
}

/* blendTargets: neutral + Σ weight × (preset − neutral). */
void rig_set_expression(rig_t *rig, int affect, float intensity, const int *blend_affects,
                        const float *blend_weights, int blend_count) {
  if (affect < 0 || affect >= RIG_AFFECT_COUNT) return;
  bool changed = affect != rig->affect;
  rig->affect = affect;
  for (int i = 0; i < RIG_PARAM_COUNT; i++) {
    float v = RIG_NEUTRAL[i] + RIG_PRESET_DELTA[affect][i] * intensity;
    for (int b = 0; b < blend_count; b++) {
      int a = blend_affects[b];
      if (a >= 0 && a < RIG_AFFECT_COUNT) v += RIG_PRESET_DELTA[a][i] * blend_weights[b];
    }
    rig->targets[i] = v;
  }
  rig->laugh = affect == AFFECT_LAUGHING ? intensity : 0;
  /* A wink belongs with these, as in her reference poses. */
  if (changed && (affect == AFFECT_PLAYFUL || affect == AFFECT_PROUD)) {
    rig_wink(rig, RIG_EYE_LEFT, 0.5f);
  }
}

void rig_set_mode(rig_t *rig, rig_mode_t mode) { rig->mode = mode; }

void rig_set_viseme(rig_t *rig, const rig_viseme_t *viseme) {
  rig->has_viseme = viseme != NULL;
  if (viseme) rig->viseme = *viseme;
}

static void push_blink(rig_t *rig, rig_blink_t b) {
  if (rig->blink_count == RIG_MAX_BLINKS) {
    memmove(&rig->blinks[0], &rig->blinks[1], sizeof(rig_blink_t) * (RIG_MAX_BLINKS - 1));
    rig->blink_count--;
  }
  rig->blinks[rig->blink_count++] = b;
}

void rig_blink(rig_t *rig, rig_eye_t eye) {
  push_blink(rig, (rig_blink_t){rig->t, eye, 0.07f, 0.025f, 0.11f});
}

void rig_wink(rig_t *rig, rig_eye_t eye, float hold_seconds) {
  push_blink(rig, (rig_blink_t){rig->t, eye, 0.09f, hold_seconds, 0.16f});
}

void rig_ring(rig_t *rig, float seconds) { rig->ring_until = rig->t + seconds; }

void rig_hop(rig_t *rig, float strength) {
  rig->springs[RIG_BOUNCE].velocity -= 150 * strength;
  rig->springs[RIG_SQUASH].velocity -= 2.2f * strength;
}

void rig_look_at(rig_t *rig, float x, float y, float hold_seconds) {
  rig->looking = true;
  rig->look_x = clampf(x, -1, 1);
  rig->look_y = clampf(y, -1, 1);
  rig->look_until = rig->t + hold_seconds;
}

static void apply_mode(const rig_t *rig, float *target, float t) {
  switch (rig->mode) {
    case RIG_MODE_LISTENING:
      target[RIG_EYE_OPEN] += 0.08f;
      target[RIG_BROW_HEIGHT] += 0.15f;
      target[RIG_HEAD_TILT] += 0.06f;
      break;
    case RIG_MODE_THINKING:
      target[RIG_PUPIL_X] = 0.55f;
      target[RIG_PUPIL_Y] = -0.55f;
      target[RIG_BROW_ASYM] += 0.3f;
      target[RIG_HAND_SPEED] += 1.5f;
      target[RIG_HEAD_TILT] += sinf(t * 1.3f) * 0.04f;
      break;
    default:
      break;
  }
}

static void apply_speech(const rig_t *rig, float *target, float t) {
  if (!rig->has_viseme) return;
  const rig_viseme_t *v = &rig->viseme;
  float open = v->open * (0.9f + 0.1f * sinf(t * 31));
  target[RIG_MOUTH_OPEN] = fmaxf(target[RIG_MOUTH_OPEN] * 0.4f, open);
  target[RIG_MOUTH_ROUND] = v->round;
  target[RIG_MOUTH_WIDTH] = lerpf(target[RIG_MOUTH_WIDTH], v->width, 0.6f);
  target[RIG_MOUTH_CURVE] *= 0.75f;
  /* Talking moves the whole face a little. */
  target[RIG_BROW_HEIGHT] += v->open * 0.14f;
  target[RIG_HEAD_TILT] += sinf(t * 2.1f) * 0.035f;
  target[RIG_BOUNCE] -= v->open * 1.5f;
}

static void apply_gaze(rig_t *rig, float *target, float t) {
  if (rig->looking && t < rig->look_until) {
    rig->gaze_x = rig->look_x;
    rig->gaze_y = rig->look_y;
  } else if (rig->mode != RIG_MODE_THINKING && t >= rig->next_saccade) {
    bool big = rnd(rig) < 0.3f;
    float nx = (rnd(rig) * 2 - 1) * (big ? 0.75f : 0.32f);
    float ny = (rnd(rig) * 2 - 1) * (big ? 0.5f : 0.22f) - 0.05f;
    /* People often blink with a large eye movement. */
    if (hypotf(nx - rig->gaze_x, ny - rig->gaze_y) > 0.5f && rnd(rig) < 0.4f) {
      rig_blink(rig, RIG_EYE_BOTH);
    }
    rig->gaze_x = nx;
    rig->gaze_y = ny;
    rig->next_saccade = t + 0.45f + rnd(rig) * 2.3f;
  }
  target[RIG_PUPIL_X] = clampf(target[RIG_PUPIL_X] + rig->gaze_x, -1, 1);
  target[RIG_PUPIL_Y] = clampf(target[RIG_PUPIL_Y] + rig->gaze_y, -1, 1);
}

static void blink_amounts(rig_t *rig, float t, float *left, float *right) {
  if (t >= rig->next_blink) {
    rig_blink(rig, RIG_EYE_BOTH);
    if (rnd(rig) < 0.18f) {
      push_blink(rig, (rig_blink_t){t + 0.24f, RIG_EYE_BOTH, 0.07f, 0.025f, 0.11f});
    }
    rig->next_blink = t + 2 + rnd(rig) * 3.8f;
  }
  *left = 0;
  *right = 0;
  int kept = 0;
  for (int i = 0; i < rig->blink_count; i++) {
    rig_blink_t b = rig->blinks[i];
    float p = t - b.start;
    float total = b.close + b.hold + b.open;
    if (p > total) continue;
    float amount = 0;
    if (p >= 0) {
      if (p < b.close) amount = ease_in(p / b.close);
      else if (p < b.close + b.hold) amount = 1;
      else amount = 1 - ease_out((p - b.close - b.hold) / b.open);
    }
    if (b.eye != RIG_EYE_RIGHT) *left = fmaxf(*left, amount);
    if (b.eye != RIG_EYE_LEFT) *right = fmaxf(*right, amount);
    rig->blinks[kept++] = b;
  }
  rig->blink_count = kept;
}

void rig_update(rig_t *rig, float dt, int hours, int minutes, int seconds, rig_frame_t *out) {
  dt = clampf(dt, 0, 1.0f / 30.0f);
  float t = (rig->t += dt);
  float target[RIG_PARAM_COUNT];
  memcpy(target, rig->targets, sizeof(target));

  apply_mode(rig, target, t);
  apply_speech(rig, target, t);
  apply_gaze(rig, target, t);

  for (int i = 0; i < RIG_PARAM_COUNT; i++) {
    rig->springs[i].target = target[i];
    out->p[i] = rig_spring_step(&rig->springs[i], dt);
  }

  /* Involuntary life layered on top of the springs. */
  float breath = sinf(t * TAU / 3.4f);
  float laugh = rig->laugh;
  out->p[RIG_BOUNCE] += breath * 1.4f + sinf(t * 16) * 2.6f * laugh;
  out->p[RIG_SQUASH] += breath * 0.012f + sinf(t * 16) * 0.035f * laugh;
  out->p[RIG_PUPIL_X] += sinf(t * 7.3f) * 0.012f;
  out->p[RIG_PUPIL_Y] += sinf(t * 5.1f + 1) * 0.012f;

  blink_amounts(rig, t, &out->blink_l, &out->blink_r);
  rig->ring = t < rig->ring_until ? 1 : fmaxf(0, rig->ring - dt * 3);
  out->ring = rig->ring;
  rig->spin += out->p[RIG_HAND_SPEED] * dt * 3.14159265f;

  float h = (float)(hours % 12) + (float)minutes / 60.0f;
  float m = (float)minutes + (float)seconds / 60.0f;
  out->hour_angle = (h / 12.0f) * TAU + rig->spin / 12.0f;
  out->minute_angle = (m / 60.0f) * TAU + rig->spin;
  out->t = t;
}

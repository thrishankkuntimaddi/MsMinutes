#include "face.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define TAU 6.28318530718f
#define PI 3.14159265359f
#define R 100.0f
/* Body units → pixels: her rim (R) is 115 px on the 240 px display. */
#define SCALE 1.15f

static const gfx_rgb_t INK = {0x2a, 0x0e, 0x05};
static const gfx_rgb_t TICK = {0x4a, 0x17, 0x09};
static const gfx_rgb_t LID = {0xf1, 0x94, 0x49};
static const gfx_rgb_t BACKDROP = {0x08, 0x05, 0x03};
static const gfx_rgb_t WHITE = {0xff, 0xff, 0xff};
static const gfx_rgb_t MOUTH_DARK = {0x3d, 0x0e, 0x05};
static const gfx_rgb_t TONGUE = {0xee, 0x7d, 0x7a};
static const gfx_rgb_t TEETH = {0xff, 0xfa, 0xf2};
static const gfx_rgb_t WINDOW_BG = {0x2e, 0x12, 0x06};
static const gfx_rgb_t WINDOW_LIT = {0xff, 0xd2, 0x7a};
static const gfx_rgb_t WINDOW_DIM = {0x4a, 0x24, 0x0c};

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Where features land: rotated by her head tilt, squashed, bounced, then scaled to pixels. */
typedef struct {
  float cx, cy;
  float cs, sn;
  float sx, sy;
  float dx, dy;
} xf_t;

static gfx_pt_t F(const xf_t *x, float px, float py) {
  float rx = px * x->cs - py * x->sn, ry = px * x->sn + py * x->cs;
  rx = rx * x->sx + x->dx;
  ry = ry * x->sy + x->dy;
  return (gfx_pt_t){x->cx + rx * SCALE, x->cy + ry * SCALE};
}

/* The dial itself doesn't move with her face. */
static gfx_pt_t D(const xf_t *x, float px, float py) {
  return (gfx_pt_t){x->cx + px * SCALE, x->cy + py * SCALE};
}

static void ellipse_f(gfx_fb_t *fb, const xf_t *x, float cx, float cy, float rx, float ry,
                      gfx_rgb_t c, float alpha, const gfx_mask_t *clip) {
  gfx_pt_t p = F(x, cx, cy);
  gfx_fill_ellipse(fb, p.x, p.y, rx * SCALE * x->sx, ry * SCALE * x->sy, c, alpha, clip);
}

static void quad_f(gfx_fb_t *fb, const xf_t *x, float x0, float y0, float cx, float cy, float x1,
                   float y1, float width, gfx_rgb_t c, float alpha, const gfx_mask_t *clip) {
  gfx_quad(fb, F(x, x0, y0), F(x, cx, cy), F(x, x1, y1), width * SCALE, c, alpha, clip);
}

/* ---------- the case ---------- */

typedef struct {
  float r;
} shade_t;

static gfx_rgb_t rim_shader(float x, float y, void *ctx) {
  shade_t *s = ctx;
  /* Gold, lit from the top left (the web's diagonal gradient). */
  float t = clampf(((x + y) / (2 * s->r) + 1) * 0.5f, 0, 1);
  static const gfx_rgb_t stops[4] = {
      {0xff, 0xf3, 0xa6}, {0xf8, 0xcb, 0x3c}, {0xea, 0xa2, 0x1b}, {0xc7, 0x7b, 0x0b}};
  static const float at[4] = {0, 0.3f, 0.7f, 1};
  for (int i = 0; i < 3; i++) {
    if (t <= at[i + 1]) return gfx_mix(stops[i], stops[i + 1], (t - at[i]) / (at[i + 1] - at[i]));
  }
  return stops[3];
}

static gfx_rgb_t face_shader(float x, float y, void *ctx) {
  shade_t *s = ctx;
  /* Warm orange, a highlight up and to the left. */
  float gx = -28 * SCALE, gy = -34 * SCALE;
  float d = hypotf(x - gx, y - gy);
  float t = clampf((d - 6 * SCALE) / (s->r + 36 * SCALE), 0, 1);
  const gfx_rgb_t a = {0xf9, 0xb0, 0x67}, b = {0xf0, 0x8d, 0x3f}, c = {0xe2, 0x71, 0x2c};
  return t < 0.65f ? gfx_mix(a, b, t / 0.65f) : gfx_mix(b, c, (t - 0.65f) / 0.35f);
}

static void dial(gfx_fb_t *fb, const xf_t *x, bool window) {
  gfx_pt_t c = D(x, 0, 0);
  shade_t rim = {R * SCALE};
  gfx_fill_disc_shaded(fb, c.x, c.y, R * SCALE, rim_shader, &rim);
  gfx_stroke_ellipse(fb, c.x, c.y, R * SCALE, R * SCALE, 3.2f * SCALE, INK, 1, NULL);

  shade_t face = {(R - 11) * SCALE};
  gfx_fill_disc_shaded(fb, c.x, c.y, (R - 11) * SCALE, face_shader, &face);
  gfx_stroke_ellipse(fb, c.x, c.y, (R - 11) * SCALE, (R - 11) * SCALE, 2 * SCALE,
                     GFX_RGB(0xe0, 0x44, 0x1f), 1, NULL);

  /* Gold rim glints. */
  const gfx_rgb_t glint = {0xff, 0xff, 0xeb};
  gfx_arc(fb, c.x, c.y, (R - 5) * SCALE, 3 * SCALE, PI * 1.1f, PI * 1.42f, glint, 0.75f, NULL);
  gfx_arc(fb, c.x, c.y, (R - 5) * SCALE, 3 * SCALE, PI * 0.1f, PI * 0.2f, glint, 0.75f, NULL);

  /* Hour ticks; the 6 o'clock one gives way to the dial window. */
  for (int i = 0; i < 12; i++) {
    if (i == 6 && window) continue;
    float a = (float)i / 12 * TAU - PI / 2;
    float ca = cosf(a), sa = sinf(a);
    if (i % 3 == 0) {
      gfx_pt_t p0 = D(x, ca * (R - 18 - 3.6f), sa * (R - 18 - 3.6f));
      gfx_pt_t p1 = D(x, ca * (R - 18 - 20 + 3.6f), sa * (R - 18 - 20 + 3.6f));
      gfx_capsule(fb, p0.x, p0.y, p1.x, p1.y, 7.2f * SCALE, TICK, 1, NULL);
    } else {
      gfx_pt_t p0 = D(x, ca * (R - 20), sa * (R - 20));
      gfx_pt_t p1 = D(x, ca * (R - 31), sa * (R - 31));
      gfx_capsule(fb, p0.x, p0.y, p1.x, p1.y, 2.4f * SCALE, TICK, 1, NULL);
    }
  }
}

/* Remaining time as a glowing arc on her rim, from 12 o'clock clockwise. */
static void countdown(gfx_fb_t *fb, const xf_t *x, const face_timer_t *timer, float t) {
  if (!timer || !timer->active) return;
  gfx_pt_t c = D(x, 0, 0);
  float r = (R - 5) * SCALE;
  if (timer->ringing) {
    bool on = sinf(t * 18) > 0;
    gfx_rgb_t col = on ? GFX_RGB(255, 70, 30) : GFX_RGB(255, 230, 120);
    gfx_arc(fb, c.x, c.y, r, 7 * SCALE, 0, TAU, col, 0.95f, NULL);
    return;
  }
  float start = -PI / 2;
  float end = start + TAU * clampf(timer->remaining, 0.002f, 1);
  gfx_arc(fb, c.x, c.y, r, 7 * SCALE, 0, TAU, GFX_RGB(90, 20, 5), 0.35f, NULL);
  gfx_arc(fb, c.x, c.y, r, 7 * SCALE, start, end, GFX_RGB(0xff, 0x4a, 0x1c), 1, NULL);
  gfx_fill_ellipse(fb, c.x + cosf(end) * r, c.y + sinf(end) * r, 3.6f * SCALE, 3.6f * SCALE,
                   GFX_RGB(0xff, 0xf3, 0xc4), 1, NULL);
}

/* ---------- the dial window: seven-segment digits set into the dial ---------- */

/* Segment bits: a top, b upper right, c lower right, d bottom, e lower left, f upper left, g mid. */
static int glyph(char ch) {
  switch (ch) {
    case '0': return 0x3F;
    case '1': return 0x06;
    case '2': return 0x5B;
    case '3': return 0x4F;
    case '4': return 0x66;
    case '5': return 0x6D;
    case '6': return 0x7D;
    case '7': return 0x07;
    case '8': return 0x7F;
    case '9': return 0x6F;
    case 'F': return 0x71;
    case 'O': return 0x3F;
    case '-': return 0x40;
    default: return 0;
  }
}

static void seven_seg(gfx_fb_t *fb, const xf_t *x, float left, float top, float w, float h,
                      int bits, gfx_rgb_t lit, gfx_rgb_t dim) {
  float sw = 1.5f;
  /* endpoints of each segment, inset so corners don't pile up */
  struct {
    float x0, y0, x1, y1;
  } seg[7] = {
      {left + sw, top, left + w - sw, top},                       /* a */
      {left + w, top + sw, left + w, top + h / 2 - sw},           /* b */
      {left + w, top + h / 2 + sw, left + w, top + h - sw},       /* c */
      {left + sw, top + h, left + w - sw, top + h},               /* d */
      {left, top + h / 2 + sw, left, top + h - sw},               /* e */
      {left, top + sw, left, top + h / 2 - sw},                   /* f */
      {left + sw, top + h / 2, left + w - sw, top + h / 2},       /* g */
  };
  for (int i = 0; i < 7; i++) {
    bool on = (bits >> i) & 1;
    gfx_pt_t p0 = D(x, seg[i].x0, seg[i].y0), p1 = D(x, seg[i].x1, seg[i].y1);
    gfx_capsule(fb, p0.x, p0.y, p1.x, p1.y, sw * SCALE, on ? lit : dim, on ? 1 : 0.6f, NULL);
  }
}

static void window(gfx_fb_t *fb, const xf_t *x, const char *text, bool flash_off) {
  const float cy = 72, hh = 8, hw = 22;
  gfx_poly_t box;
  gfx_poly_begin(&box, D(x, -hw + 3, cy - hh));
  gfx_poly_line(&box, D(x, hw - 3, cy - hh));
  gfx_poly_quad(&box, D(x, hw, cy - hh), D(x, hw, cy - hh + 3), 3);
  gfx_poly_line(&box, D(x, hw, cy + hh - 3));
  gfx_poly_quad(&box, D(x, hw, cy + hh), D(x, hw - 3, cy + hh), 3);
  gfx_poly_line(&box, D(x, -hw + 3, cy + hh));
  gfx_poly_quad(&box, D(x, -hw, cy + hh), D(x, -hw, cy + hh - 3), 3);
  gfx_poly_line(&box, D(x, -hw, cy - hh + 3));
  gfx_poly_quad(&box, D(x, -hw, cy - hh), D(x, -hw + 3, cy - hh), 3);
  gfx_fill_poly(fb, &box, WINDOW_BG, 1, NULL);
  gfx_stroke_poly(fb, &box, 1.6f * SCALE, TICK, 1, NULL);

  /* Digits are 5.5 wide, 10 tall; a colon takes 4. */
  const float dw = 5.5f, dh = 10, adv = 8.4f, colon = 4;
  float width = 0;
  for (const char *p = text; *p; p++) width += *p == ':' ? colon : adv;
  float pen = -width / 2 + 1.4f;
  float top = cy - dh / 2;
  gfx_rgb_t lit = flash_off ? WINDOW_DIM : WINDOW_LIT;
  for (const char *p = text; *p; p++) {
    if (*p == ':') {
      gfx_pt_t a = D(x, pen + 1.2f, top + dh * 0.3f), b = D(x, pen + 1.2f, top + dh * 0.72f);
      gfx_fill_ellipse(fb, a.x, a.y, 1 * SCALE, 1 * SCALE, lit, 1, NULL);
      gfx_fill_ellipse(fb, b.x, b.y, 1 * SCALE, 1 * SCALE, lit, 1, NULL);
      pen += colon;
      continue;
    }
    seven_seg(fb, x, pen, top, dw, dh, glyph(*p), lit, WINDOW_DIM);
    pen += adv;
  }
}

void face_format_countdown(int seconds, char out[8]) {
  if (seconds < 0) seconds = 0;
  if (seconds >= 3600) snprintf(out, 8, "%d:%02d", seconds / 3600, (seconds % 3600) / 60);
  else snprintf(out, 8, "%d:%02d", seconds / 60, seconds % 60);
}

/* ---------- features ---------- */

static void cheeks(gfx_fb_t *fb, const xf_t *x, const rig_frame_t *f) {
  float cheek = clampf(f->p[RIG_CHEEK], 0, 1);
  for (int side = -1; side <= 1; side += 2) {
    ellipse_f(fb, x, side * 52.0f, 18, 15, 9.5f, GFX_RGB(240, 96, 96), 0.22f + 0.45f * cheek, NULL);
    if (cheek > 0.85f) {
      /* Blushing hard: little hatch marks. */
      for (int i = -1; i <= 1; i++) {
        gfx_pt_t a = F(x, side * 52.0f + i * 5 - 2, 22), b = F(x, side * 52.0f + i * 5 + 2, 14);
        gfx_capsule(fb, a.x, a.y, b.x, b.y, 1.4f * SCALE, GFX_RGB(200, 50, 50),
                    clampf((cheek - 0.85f) * 4, 0, 1), NULL);
      }
    }
  }
}

/* Three curled lashes at the outer top corner, in eye-local units around (ex, ey). */
static void lashes(gfx_fb_t *fb, const xf_t *x, float ex, float ey, int outer, float base_y,
                   float rx, float ry) {
  for (int i = 0; i < 3; i++) {
    float a = -PI / 2 + outer * (0.55f + i * 0.33f);
    float lx = cosf(a) * rx;
    float ly = sinf(a) * ry + base_y + ry - 6;
    quad_f(fb, x, ex + lx, ey + ly, ex + lx + outer * 7, ey + ly - 2, ex + lx + outer * 7,
           ey + ly - 8 + i * 2, 2.6f, INK, 1, NULL);
  }
}

static void eye(gfx_fb_t *fb, gfx_mask_t *mask, const xf_t *x, const rig_frame_t *f, int side) {
  const float ex = side * 33.0f, ey = -18;
  float blink = side == -1 ? f->blink_l : f->blink_r;
  float eye_open = f->p[RIG_EYE_OPEN], squint = f->p[RIG_EYE_SQUINT];
  float wide = fmaxf(0, eye_open - 1);
  float rx = 20 * (1 + wide * 0.22f), ry = 27 * (1 + wide * 0.4f);
  float open = clampf(eye_open, 0, 1) * (1 - blink);
  int outer = side;

  if (open < 0.14f || (squint > 0.75f && open < 0.55f)) {
    /* Closed: a happy arch when smiling (laughing, winking), a soft curve otherwise. */
    bool happy = f->p[RIG_MOUTH_CURVE] > 0.4f || squint > 0.5f;
    if (happy) quad_f(fb, x, ex - 17, ey + 6, ex, ey - 18, ex + 17, ey + 6, 3.6f, INK, 1, NULL);
    else quad_f(fb, x, ex - 17, ey + 2, ex, ey + 14, ex + 17, ey + 2, 3.6f, INK, 1, NULL);
    lashes(fb, x, ex, ey, outer, happy ? -6 : 0, 16, 8);
    return;
  }

  gfx_pt_t c = F(x, ex, ey);
  float prx = rx * SCALE * x->sx, pry = ry * SCALE * x->sy;
  gfx_mask_clear(mask);
  gfx_mask_ellipse(mask, c.x, c.y, prx, pry);
  gfx_fill_ellipse(fb, c.x, c.y, prx, pry, GFX_RGB(0xfb, 0xf5, 0xea), 1, NULL);
  gfx_fill_ellipse(fb, c.x - 3 * SCALE, c.y - 7 * SCALE, prx * 0.8f, pry * 0.65f, WHITE, 0.6f,
                   mask);

  /* Big dark pupils with two catchlights. */
  float px = f->p[RIG_PUPIL_X] * rx * 0.42f, py = f->p[RIG_PUPIL_Y] * ry * 0.34f + 3;
  float size = f->p[RIG_PUPIL_SIZE];
  float pupil_rx = 12.5f * size, pupil_ry = 16.5f * size;
  ellipse_f(fb, x, ex + px, ey + py, pupil_rx, pupil_ry, GFX_RGB(0x12, 0x05, 0x01), 1, mask);
  ellipse_f(fb, x, ex + px, ey + py, pupil_rx * 0.78f, pupil_ry * 0.78f,
            GFX_RGB(0x2a, 0x0f, 0x05), 1, mask);
  ellipse_f(fb, x, ex + px - 2, ey + py - 3, pupil_rx * 0.4f, pupil_ry * 0.4f,
            GFX_RGB(0x5a, 0x2a, 0x10), 0.8f, mask);
  ellipse_f(fb, x, ex + px + 3.5f, ey + py - 6, 3.8f, 4.6f, WHITE, 1, mask);
  ellipse_f(fb, x, ex + px - 4, ey + py + 5, 1.8f, 1.8f, WHITE, 1, mask);

  /* Upper lid comes down with blinks, sleepiness, and slants with the brows. */
  float lid_y = -ry + 2 * ry * (1 - open);
  float tilt = f->p[RIG_BROW_ANGLE] * 7 * (1 - blink);
  float y_in = lid_y - tilt, y_out = lid_y + tilt * 0.6f;
  float x_in = -outer * (rx + 3), x_out = outer * (rx + 3);
  gfx_poly_t lid;
  gfx_poly_begin(&lid, F(x, ex + x_out, ey - ry - 30));
  gfx_poly_line(&lid, F(x, ex + x_in, ey - ry - 30));
  gfx_poly_line(&lid, F(x, ex + x_in, ey + y_in));
  gfx_poly_quad(&lid, F(x, ex, ey + (y_in + y_out) / 2 + 8), F(x, ex + x_out, ey + y_out), 10);
  gfx_fill_poly(fb, &lid, LID, 1, mask);
  if (open < 0.97f || fabsf(tilt) > 1) {
    quad_f(fb, x, ex + x_in, ey + y_in, ex, ey + (y_in + y_out) / 2 + 8, ex + x_out, ey + y_out,
           3, INK, 1, mask);
  }

  /* Lower lid rises when she smiles with her eyes. */
  if (squint > 0.05f) {
    float low_y = ry - squint * ry * 0.95f;
    gfx_poly_t lower;
    gfx_poly_begin(&lower, F(x, ex - rx - 3, ey + ry + 30));
    gfx_poly_line(&lower, F(x, ex + rx + 3, ey + ry + 30));
    gfx_poly_line(&lower, F(x, ex + rx + 3, ey + low_y));
    gfx_poly_quad(&lower, F(x, ex, ey + low_y - 9 * squint), F(x, ex - rx - 3, ey + low_y), 10);
    gfx_fill_poly(fb, &lower, LID, 1, mask);
    quad_f(fb, x, ex + rx + 3, ey + low_y, ex, ey + low_y - 9 * squint, ex - rx - 3, ey + low_y,
           2.2f, INK, clampf(squint * 2, 0, 1), mask);
  }

  gfx_stroke_ellipse(fb, c.x, c.y, prx, pry, 3.2f * SCALE, INK, 1, NULL);
  float vis = fmaxf(0.45f, open);
  lashes(fb, x, ex, ey, outer, -ry * vis + 6, rx, ry * vis);
}

static void brow(gfx_fb_t *fb, const xf_t *x, const rig_frame_t *f, int side) {
  int inner = -side;
  float asym = side == -1 ? f->p[RIG_BROW_ASYM] : -f->p[RIG_BROW_ASYM];
  float angle = f->p[RIG_BROW_ANGLE];
  float wide = fmaxf(0, f->p[RIG_EYE_OPEN] - 1) * 10;
  float base_y = -56 - wide - f->p[RIG_BROW_HEIGHT] * 9 - asym * 5;
  float x_in = side * 33.0f + inner * 13, x_out = side * 33.0f - inner * 16;
  float y_in = base_y - angle * 8, y_out = base_y + angle * 3 + 3;
  float arch = 8 - fmaxf(0, -angle) * 7;
  quad_f(fb, x, x_out, y_out, side * 33.0f, (y_in + y_out) / 2 - arch, x_in, y_in, 3.4f, INK, 1,
         NULL);
}

static void mouth(gfx_fb_t *fb, gfx_mask_t *mask, const xf_t *x, const rig_frame_t *f) {
  const float cy = 34;
  float open = fmaxf(0, f->p[RIG_MOUTH_OPEN]);
  float curve = f->p[RIG_MOUTH_CURVE];
  float round = f->p[RIG_MOUTH_ROUND];

  /* "Oh!": a round mouth. */
  if (round > 0.55f && open > 0.2f) {
    float w = 10 + open * 6, h = 12 + open * 14;
    gfx_pt_t c = F(x, 0, cy + 4);
    float prx = w * SCALE * x->sx, pry = h * SCALE * x->sy;
    gfx_mask_clear(mask);
    gfx_mask_ellipse(mask, c.x, c.y, prx, pry);
    gfx_fill_ellipse(fb, c.x, c.y, prx, pry, MOUTH_DARK, 1, NULL);
    ellipse_f(fb, x, 0, cy + 4 + h * 0.75f, w * 0.9f, h * 0.55f, TONGUE, 1, mask);
    gfx_stroke_ellipse(fb, c.x, c.y, prx, pry, 3 * SCALE, INK, 1, NULL);
    return;
  }

  float w = 28 * f->p[RIG_MOUTH_WIDTH] * (1 - 0.35f * round);
  float corner_y = cy - curve * 8;
  float upper_mid = cy + curve * 3 - open * 2;
  float lower_mid = upper_mid + 4 + open * 34 + fmaxf(0, curve) * open * 10;
#define CTRL(mid) (2 * (mid) - corner_y)

  if (open < 0.06f) {
    quad_f(fb, x, -w, corner_y, 0, CTRL(cy + curve * 9), w, corner_y, 3.2f, INK, 1, NULL);
    if (curve > 0.4f) {
      /* Dimples at the corners. */
      for (int side = -1; side <= 1; side += 2) {
        quad_f(fb, x, side * (w - 2), corner_y - 4, side * (w + 4), corner_y, side * (w - 1),
               corner_y + 4, 3.2f, INK, 1, NULL);
      }
    }
    return;
  }

  /* Open: a wide "D"; flat top lip, deep rounded bottom, teeth and a pink tongue. */
  gfx_poly_t m;
  gfx_poly_begin(&m, F(x, -w, corner_y));
  gfx_poly_quad(&m, F(x, 0, CTRL(upper_mid)), F(x, w, corner_y), 12);
  gfx_poly_cubic(&m, F(x, w * 0.9f, lower_mid + 4), F(x, -w * 0.9f, lower_mid + 4),
                 F(x, -w, corner_y), 16);
  gfx_mask_clear(mask);
  gfx_mask_poly(mask, &m);
  gfx_fill_poly(fb, &m, MOUTH_DARK, 1, NULL);
  if (open > 0.2f && curve > -0.2f) {
    gfx_poly_t teeth;
    gfx_poly_begin(&teeth, F(x, -w, corner_y - 2));
    gfx_poly_quad(&teeth, F(x, 0, CTRL(upper_mid) - 2), F(x, w, corner_y - 2), 10);
    gfx_poly_line(&teeth, F(x, w, corner_y + 6));
    gfx_poly_quad(&teeth, F(x, 0, CTRL(upper_mid + 6)), F(x, -w, corner_y + 6), 10);
    gfx_fill_poly(fb, &teeth, TEETH, 1, mask);
  }
  ellipse_f(fb, x, 0, lower_mid + 2, w * 0.6f, 6 + open * 10, TONGUE, 1, mask);
  ellipse_f(fb, x, -w * 0.15f, lower_mid - 4 - open * 2, w * 0.18f, 2.5f, WHITE, 0.25f, mask);
  gfx_stroke_poly(fb, &m, 3.2f * SCALE, INK, 1, NULL);
  if (curve > 0.4f) {
    /* Smile creases. */
    for (int side = -1; side <= 1; side += 2) {
      quad_f(fb, x, side * (w - 1), corner_y - 5, side * (w + 5), corner_y - 1, side * (w + 2),
             corner_y + 4, 2.4f, INK, 1, NULL);
    }
  }
#undef CTRL
}

static void tear(gfx_fb_t *fb, const xf_t *x, const rig_frame_t *f) {
  float k = clampf(f->p[RIG_TEAR], 0, 1);
  if (k < 0.05f) return;
  for (int side = -1; side <= 1; side += 2) {
    float p = fmodf(f->t * 0.45f + (side > 0 ? 0.5f : 0), 1);
    float tx = side * 41.0f, ty = 8 + p * 36;
    float alpha = k * (1 - p * 0.6f);
    gfx_poly_t drop;
    gfx_poly_begin(&drop, F(x, tx, ty - 9));
    gfx_poly_cubic(&drop, F(x, tx + 6, ty - 1), F(x, tx + 6, ty + 6), F(x, tx, ty + 6), 8);
    gfx_poly_cubic(&drop, F(x, tx - 6, ty + 6), F(x, tx - 6, ty - 1), F(x, tx, ty - 9), 8);
    gfx_fill_poly(fb, &drop, GFX_RGB(0x8f, 0xd3, 0xff), alpha, NULL);
    gfx_stroke_poly(fb, &drop, 1.5f * SCALE, GFX_RGB(0x2f, 0x7f, 0xb8), alpha, NULL);
    ellipse_f(fb, x, tx - 1.8f, ty + 1, 1.5f, 1.5f, WHITE, 0.8f * alpha, NULL);
  }
}

void face_draw(gfx_fb_t *fb, gfx_mask_t *scratch, const rig_frame_t *f,
               const face_timer_t *timer, const face_status_t *status) {
  gfx_fill(fb, BACKDROP);

  float tilt = f->p[RIG_HEAD_TILT] * 0.55f;
  float squash = f->p[RIG_SQUASH];
  xf_t x = {
      .cx = fb->w / 2.0f,
      .cy = fb->h / 2.0f,
      .cs = cosf(tilt),
      .sn = sinf(tilt),
      .sx = 1 + squash * 0.8f,
      .sy = 1 - squash,
      /* Her bells shake the whole face. */
      .dx = sinf(f->t * 40) * 3 * f->ring,
      /* Leaning toward you tips her features down a little. */
      .dy = f->p[RIG_BOUNCE] * 0.6f + f->p[RIG_LEAN] * 22,
  };

  const char *text = NULL;
  bool flash_off = false;
  if (timer && timer->active) {
    text = timer->ringing ? "0:00" : timer->readout;
    flash_off = timer->ringing && sinf(f->t * 18) <= 0;
  } else if (status && !status->online) {
    text = "OFF";
  } else if (status && status->clock[0]) {
    text = status->clock;
  }

  dial(fb, &x, text != NULL);
  countdown(fb, &x, timer, f->t);
  if (text) window(fb, &x, text, flash_off);

  cheeks(fb, &x, f);
  eye(fb, scratch, &x, f, -1);
  eye(fb, scratch, &x, f, 1);
  brow(fb, &x, f, -1);
  brow(fb, &x, f, 1);
  /* Her nose is the clock's centre pin. */
  ellipse_f(fb, &x, 0, 6, 4.6f, 4.6f, TICK, 1, NULL);
  mouth(fb, scratch, &x, f);
  tear(fb, &x, f);
}

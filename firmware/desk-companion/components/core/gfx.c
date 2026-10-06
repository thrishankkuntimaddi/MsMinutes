#include "gfx.h"

#include <math.h>
#include <string.h>

#define TAU 6.28318530718f

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static int floori(float v) { return (int)floorf(v); }
static int ceili(float v) { return (int)ceilf(v); }

uint16_t gfx_pack(gfx_rgb_t c) {
  return (uint16_t)(((c.r & 0xF8) << 8) | ((c.g & 0xFC) << 3) | (c.b >> 3));
}

gfx_rgb_t gfx_unpack(uint16_t c) {
  gfx_rgb_t out;
  out.r = (uint8_t)(((c >> 11) & 0x1F) * 255 / 31);
  out.g = (uint8_t)(((c >> 5) & 0x3F) * 255 / 63);
  out.b = (uint8_t)((c & 0x1F) * 255 / 31);
  return out;
}

gfx_rgb_t gfx_mix(gfx_rgb_t a, gfx_rgb_t b, float t) {
  t = clampf(t, 0, 1);
  gfx_rgb_t out;
  out.r = (uint8_t)(a.r + (b.r - a.r) * t + 0.5f);
  out.g = (uint8_t)(a.g + (b.g - a.g) * t + 0.5f);
  out.b = (uint8_t)(a.b + (b.b - a.b) * t + 0.5f);
  return out;
}

void gfx_fill(gfx_fb_t *fb, gfx_rgb_t c) {
  uint16_t v = gfx_pack(c);
  int n = fb->w * fb->h;
  for (int i = 0; i < n; i++) fb->px[i] = v;
}

static inline void blend_at(gfx_fb_t *fb, int x, int y, gfx_rgb_t c, float alpha) {
  if (alpha <= 0.002f) return;
  uint16_t *dst = &fb->px[y * fb->w + x];
  if (alpha >= 0.998f) {
    *dst = gfx_pack(c);
    return;
  }
  gfx_rgb_t d = gfx_unpack(*dst);
  *dst = gfx_pack(gfx_mix(d, c, alpha));
}

void gfx_blend_px(gfx_fb_t *fb, int x, int y, gfx_rgb_t c, float alpha) {
  if (x < 0 || y < 0 || x >= fb->w || y >= fb->h) return;
  blend_at(fb, x, y, c, alpha);
}

static inline float clip_at(const gfx_mask_t *clip, int x, int y) {
  return clip ? (float)clip->a[y * clip->w + x] * (1.0f / 255.0f) : 1.0f;
}

/* ---------- masks ---------- */

void gfx_mask_clear(gfx_mask_t *m) {
  if (m->x1 < m->x0 || m->y1 < m->y0) return;
  for (int y = m->y0; y <= m->y1; y++) {
    memset(&m->a[y * m->w + m->x0], 0, (size_t)(m->x1 - m->x0 + 1));
  }
  m->x0 = m->w;
  m->y0 = m->h;
  m->x1 = -1;
  m->y1 = -1;
}

static void mask_touch(gfx_mask_t *m, int x0, int y0, int x1, int y1) {
  if (x0 < m->x0) m->x0 = x0;
  if (y0 < m->y0) m->y0 = y0;
  if (x1 > m->x1) m->x1 = x1;
  if (y1 > m->y1) m->y1 = y1;
}

/* Signed distance to an ellipse edge, in pixels (approximate, good for 1 px AA). */
static inline float ellipse_dist(float dx, float dy, float rx, float ry) {
  float k = sqrtf((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  return (k - 1) * fminf(rx, ry);
}

void gfx_mask_ellipse(gfx_mask_t *m, float cx, float cy, float rx, float ry) {
  int x0 = clampi(floori(cx - rx - 1), 0, m->w - 1), x1 = clampi(ceili(cx + rx + 1), 0, m->w - 1);
  int y0 = clampi(floori(cy - ry - 1), 0, m->h - 1), y1 = clampi(ceili(cy + ry + 1), 0, m->h - 1);
  if (x1 < x0 || y1 < y0) return;
  mask_touch(m, x0, y0, x1, y1);
  for (int y = y0; y <= y1; y++) {
    float dy = (float)y + 0.5f - cy;
    for (int x = x0; x <= x1; x++) {
      float cov = clampf(0.5f - ellipse_dist((float)x + 0.5f - cx, dy, rx, ry), 0, 1);
      if (cov > 0) {
        uint8_t *a = &m->a[y * m->w + x];
        int v = *a + (int)(cov * 255);
        *a = (uint8_t)(v > 255 ? 255 : v);
      }
    }
  }
}

/* ---------- polygons: scanline coverage with 4 sub-rows and fractional ends ---------- */

#define SUBROWS 4

typedef void (*span_fn)(void *ctx, int y, const float *cov, int x0, int x1);

static void poly_scan(const gfx_poly_t *poly, int w, int h, span_fn emit, void *ctx) {
  if (poly->n < 3) return;
  float miny = 1e9f, maxy = -1e9f, minx = 1e9f, maxx = -1e9f;
  for (int i = 0; i < poly->n; i++) {
    miny = fminf(miny, poly->p[i].y);
    maxy = fmaxf(maxy, poly->p[i].y);
    minx = fminf(minx, poly->p[i].x);
    maxx = fmaxf(maxx, poly->p[i].x);
  }
  int y0 = clampi(floori(miny), 0, h - 1), y1 = clampi(ceili(maxy), 0, h - 1);
  int bx0 = clampi(floori(minx), 0, w - 1), bx1 = clampi(ceili(maxx), 0, w - 1);
  if (y1 < y0 || bx1 < bx0) return;
  float cov[512];
  float xs[GFX_MAX_POLY];
  for (int y = y0; y <= y1; y++) {
    memset(cov, 0, sizeof(float) * (size_t)(bx1 - bx0 + 1));
    bool any = false;
    for (int s = 0; s < SUBROWS; s++) {
      float sy = (float)y + ((float)s + 0.5f) / SUBROWS;
      int n = 0;
      for (int i = 0; i < poly->n; i++) {
        gfx_pt_t a = poly->p[i], b = poly->p[(i + 1) % poly->n];
        if ((sy >= a.y) == (sy >= b.y)) continue;
        xs[n++] = a.x + (sy - a.y) * (b.x - a.x) / (b.y - a.y);
      }
      /* insertion sort: few crossings */
      for (int i = 1; i < n; i++) {
        float v = xs[i];
        int j = i - 1;
        while (j >= 0 && xs[j] > v) {
          xs[j + 1] = xs[j];
          j--;
        }
        xs[j + 1] = v;
      }
      for (int i = 0; i + 1 < n; i += 2) {
        float xa = clampf(xs[i], (float)bx0, (float)bx1 + 1);
        float xb = clampf(xs[i + 1], (float)bx0, (float)bx1 + 1);
        if (xb <= xa) continue;
        any = true;
        int ia = floori(xa), ib = floori(xb);
        if (ib > bx1) ib = bx1;
        if (ia == ib) {
          cov[ia - bx0] += (xb - xa) / SUBROWS;
        } else {
          cov[ia - bx0] += ((float)(ia + 1) - xa) / SUBROWS;
          for (int x = ia + 1; x < ib; x++) cov[x - bx0] += 1.0f / SUBROWS;
          if (ib <= bx1) cov[ib - bx0] += (xb - (float)ib) / SUBROWS;
        }
      }
    }
    if (any) emit(ctx, y, cov, bx0, bx1);
  }
}

typedef struct {
  gfx_fb_t *fb;
  gfx_rgb_t c;
  float alpha;
  const gfx_mask_t *clip;
} fill_ctx_t;

static void fill_span(void *vctx, int y, const float *cov, int x0, int x1) {
  fill_ctx_t *ctx = vctx;
  for (int x = x0; x <= x1; x++) {
    float a = cov[x - x0];
    if (a <= 0) continue;
    blend_at(ctx->fb, x, y, ctx->c, clampf(a, 0, 1) * ctx->alpha * clip_at(ctx->clip, x, y));
  }
}

typedef struct {
  gfx_mask_t *m;
} mask_ctx_t;

static void mask_span(void *vctx, int y, const float *cov, int x0, int x1) {
  mask_ctx_t *ctx = vctx;
  mask_touch(ctx->m, x0, y, x1, y);
  for (int x = x0; x <= x1; x++) {
    float a = clampf(cov[x - x0], 0, 1);
    if (a <= 0) continue;
    uint8_t *p = &ctx->m->a[y * ctx->m->w + x];
    int v = *p + (int)(a * 255);
    *p = (uint8_t)(v > 255 ? 255 : v);
  }
}

void gfx_mask_poly(gfx_mask_t *m, const gfx_poly_t *poly) {
  mask_ctx_t ctx = {m};
  poly_scan(poly, m->w, m->h, mask_span, &ctx);
}

void gfx_fill_poly(gfx_fb_t *fb, const gfx_poly_t *poly, gfx_rgb_t c, float alpha,
                   const gfx_mask_t *clip) {
  fill_ctx_t ctx = {fb, c, alpha, clip};
  poly_scan(poly, fb->w, fb->h, fill_span, &ctx);
}

void gfx_stroke_poly(gfx_fb_t *fb, const gfx_poly_t *poly, float width, gfx_rgb_t c, float alpha,
                     const gfx_mask_t *clip) {
  for (int i = 0; i < poly->n; i++) {
    gfx_pt_t a = poly->p[i], b = poly->p[(i + 1) % poly->n];
    gfx_capsule(fb, a.x, a.y, b.x, b.y, width, c, alpha, clip);
  }
}

void gfx_poly_begin(gfx_poly_t *poly, gfx_pt_t p) {
  poly->n = 1;
  poly->p[0] = p;
}

void gfx_poly_line(gfx_poly_t *poly, gfx_pt_t p) {
  if (poly->n < GFX_MAX_POLY) poly->p[poly->n++] = p;
}

void gfx_poly_quad(gfx_poly_t *poly, gfx_pt_t c, gfx_pt_t p, int segments) {
  if (poly->n == 0) return;
  gfx_pt_t a = poly->p[poly->n - 1];
  for (int i = 1; i <= segments; i++) {
    float t = (float)i / (float)segments, u = 1 - t;
    gfx_poly_line(poly, (gfx_pt_t){u * u * a.x + 2 * u * t * c.x + t * t * p.x,
                                   u * u * a.y + 2 * u * t * c.y + t * t * p.y});
  }
}

void gfx_poly_cubic(gfx_poly_t *poly, gfx_pt_t c1, gfx_pt_t c2, gfx_pt_t p, int segments) {
  if (poly->n == 0) return;
  gfx_pt_t a = poly->p[poly->n - 1];
  for (int i = 1; i <= segments; i++) {
    float t = (float)i / (float)segments, u = 1 - t;
    float b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
    gfx_poly_line(poly, (gfx_pt_t){b0 * a.x + b1 * c1.x + b2 * c2.x + b3 * p.x,
                                   b0 * a.y + b1 * c1.y + b2 * c2.y + b3 * p.y});
  }
}

/* ---------- ellipses ---------- */

void gfx_fill_ellipse(gfx_fb_t *fb, float cx, float cy, float rx, float ry, gfx_rgb_t c,
                      float alpha, const gfx_mask_t *clip) {
  if (rx <= 0 || ry <= 0) return;
  int x0 = clampi(floori(cx - rx - 1), 0, fb->w - 1), x1 = clampi(ceili(cx + rx + 1), 0, fb->w - 1);
  int y0 = clampi(floori(cy - ry - 1), 0, fb->h - 1), y1 = clampi(ceili(cy + ry + 1), 0, fb->h - 1);
  for (int y = y0; y <= y1; y++) {
    float dy = (float)y + 0.5f - cy;
    for (int x = x0; x <= x1; x++) {
      float cov = clampf(0.5f - ellipse_dist((float)x + 0.5f - cx, dy, rx, ry), 0, 1);
      if (cov > 0) blend_at(fb, x, y, c, cov * alpha * clip_at(clip, x, y));
    }
  }
}

void gfx_stroke_ellipse(gfx_fb_t *fb, float cx, float cy, float rx, float ry, float width,
                        gfx_rgb_t c, float alpha, const gfx_mask_t *clip) {
  float hw = width / 2;
  int x0 = clampi(floori(cx - rx - hw - 1), 0, fb->w - 1);
  int x1 = clampi(ceili(cx + rx + hw + 1), 0, fb->w - 1);
  int y0 = clampi(floori(cy - ry - hw - 1), 0, fb->h - 1);
  int y1 = clampi(ceili(cy + ry + hw + 1), 0, fb->h - 1);
  for (int y = y0; y <= y1; y++) {
    float dy = (float)y + 0.5f - cy;
    for (int x = x0; x <= x1; x++) {
      float d = fabsf(ellipse_dist((float)x + 0.5f - cx, dy, rx, ry));
      float cov = clampf(hw + 0.5f - d, 0, 1);
      if (cov > 0) blend_at(fb, x, y, c, cov * alpha * clip_at(clip, x, y));
    }
  }
}

void gfx_fill_disc_shaded(gfx_fb_t *fb, float cx, float cy, float r, gfx_shader_t shader,
                          void *ctx) {
  int x0 = clampi(floori(cx - r - 1), 0, fb->w - 1), x1 = clampi(ceili(cx + r + 1), 0, fb->w - 1);
  int y0 = clampi(floori(cy - r - 1), 0, fb->h - 1), y1 = clampi(ceili(cy + r + 1), 0, fb->h - 1);
  for (int y = y0; y <= y1; y++) {
    float dy = (float)y + 0.5f - cy;
    for (int x = x0; x <= x1; x++) {
      float dx = (float)x + 0.5f - cx;
      float cov = clampf(0.5f - (sqrtf(dx * dx + dy * dy) - r), 0, 1);
      if (cov > 0) blend_at(fb, x, y, shader(dx, dy, ctx), cov);
    }
  }
}

/* ---------- strokes ---------- */

void gfx_capsule(gfx_fb_t *fb, float x1, float y1, float x2, float y2, float width, gfx_rgb_t c,
                 float alpha, const gfx_mask_t *clip) {
  float hw = width / 2;
  int bx0 = clampi(floori(fminf(x1, x2) - hw - 1), 0, fb->w - 1);
  int bx1 = clampi(ceili(fmaxf(x1, x2) + hw + 1), 0, fb->w - 1);
  int by0 = clampi(floori(fminf(y1, y2) - hw - 1), 0, fb->h - 1);
  int by1 = clampi(ceili(fmaxf(y1, y2) + hw + 1), 0, fb->h - 1);
  float ex = x2 - x1, ey = y2 - y1;
  float len2 = ex * ex + ey * ey;
  for (int y = by0; y <= by1; y++) {
    float py = (float)y + 0.5f - y1;
    for (int x = bx0; x <= bx1; x++) {
      float px = (float)x + 0.5f - x1;
      float t = len2 > 0 ? clampf((px * ex + py * ey) / len2, 0, 1) : 0;
      float dx = px - ex * t, dy = py - ey * t;
      float cov = clampf(hw + 0.5f - sqrtf(dx * dx + dy * dy), 0, 1);
      if (cov > 0) blend_at(fb, x, y, c, cov * alpha * clip_at(clip, x, y));
    }
  }
}

void gfx_quad(gfx_fb_t *fb, gfx_pt_t p0, gfx_pt_t c, gfx_pt_t p1, float width, gfx_rgb_t col,
              float alpha, const gfx_mask_t *clip) {
  /* Flattened into capsules. Caps overlap, which is invisible for opaque strokes. */
  const int segments = 10;
  gfx_pt_t prev = p0;
  for (int i = 1; i <= segments; i++) {
    float t = (float)i / segments, u = 1 - t;
    gfx_pt_t p = {u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
                  u * u * p0.y + 2 * u * t * c.y + t * t * p1.y};
    gfx_capsule(fb, prev.x, prev.y, p.x, p.y, width, col, alpha, clip);
    prev = p;
  }
}

static float wrap_angle(float a) {
  a = fmodf(a, TAU);
  return a < 0 ? a + TAU : a;
}

void gfx_arc(gfx_fb_t *fb, float cx, float cy, float r, float width, float a0, float a1,
             gfx_rgb_t c, float alpha, const gfx_mask_t *clip) {
  float hw = width / 2;
  float sweep = a1 - a0;
  bool full = sweep >= TAU - 1e-4f;
  if (sweep <= 0) return;
  float start = wrap_angle(a0);
  float ex0 = cx + cosf(a0) * r, ey0 = cy + sinf(a0) * r;
  float ex1 = cx + cosf(a1) * r, ey1 = cy + sinf(a1) * r;
  float ro = r + hw + 1, ri = fmaxf(0, r - hw - 1);
  int y0 = clampi(floori(cy - ro), 0, fb->h - 1), y1 = clampi(ceili(cy + ro), 0, fb->h - 1);
  for (int y = y0; y <= y1; y++) {
    float dy = (float)y + 0.5f - cy;
    float half = sqrtf(fmaxf(0, ro * ro - dy * dy));
    int x0 = clampi(floori(cx - half), 0, fb->w - 1), x1 = clampi(ceili(cx + half), 0, fb->w - 1);
    for (int x = x0; x <= x1; x++) {
      float dx = (float)x + 0.5f - cx;
      float d2 = dx * dx + dy * dy;
      if (d2 < ri * ri) continue;
      float d = sqrtf(d2);
      float cov = clampf(hw + 0.5f - fabsf(d - r), 0, 1);
      if (cov <= 0) continue;
      if (!full) {
        float rel = wrap_angle(atan2f(dy, dx) - start);
        if (rel > sweep) {
          /* Outside the sweep: only the round caps can cover this pixel. */
          float c0 = hypotf((float)x + 0.5f - ex0, (float)y + 0.5f - ey0);
          float c1 = hypotf((float)x + 0.5f - ex1, (float)y + 0.5f - ey1);
          cov = clampf(hw + 0.5f - fminf(c0, c1), 0, 1);
          if (cov <= 0) continue;
        }
      }
      blend_at(fb, x, y, c, cov * alpha * clip_at(clip, x, y));
    }
  }
}

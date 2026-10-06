/*
 * A small anti-aliased software rasterizer for RGB565 framebuffers. Just enough to draw
 * her: ellipses, thick curves, polygons with coverage, arcs, clip masks and shaded discs.
 * Pure C; the same code renders on the ESP32-S3 and in the host tests.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define GFX_MAX_POLY 96

typedef struct {
  uint8_t r, g, b;
} gfx_rgb_t;

typedef struct {
  float x, y;
} gfx_pt_t;

typedef struct {
  int w, h;
  uint16_t *px; /* RGB565, row-major, native byte order */
} gfx_fb_t;

/* 8-bit coverage per pixel; drawing through it multiplies alpha by coverage. */
typedef struct {
  int w, h;
  uint8_t *a;
  int x0, y0, x1, y1; /* touched region, so clearing is cheap */
} gfx_mask_t;

typedef struct {
  gfx_pt_t p[GFX_MAX_POLY];
  int n;
} gfx_poly_t;

/* Colour of (x, y) for shaded fills. */
typedef gfx_rgb_t (*gfx_shader_t)(float x, float y, void *ctx);

#define GFX_RGB(r, g, b) ((gfx_rgb_t){(r), (g), (b)})

uint16_t gfx_pack(gfx_rgb_t c);
gfx_rgb_t gfx_unpack(uint16_t c);
gfx_rgb_t gfx_mix(gfx_rgb_t a, gfx_rgb_t b, float t);

void gfx_fill(gfx_fb_t *fb, gfx_rgb_t c);
void gfx_blend_px(gfx_fb_t *fb, int x, int y, gfx_rgb_t c, float alpha);

void gfx_mask_clear(gfx_mask_t *m);
void gfx_mask_ellipse(gfx_mask_t *m, float cx, float cy, float rx, float ry);
void gfx_mask_poly(gfx_mask_t *m, const gfx_poly_t *poly);

void gfx_fill_ellipse(gfx_fb_t *fb, float cx, float cy, float rx, float ry, gfx_rgb_t c,
                      float alpha, const gfx_mask_t *clip);
void gfx_stroke_ellipse(gfx_fb_t *fb, float cx, float cy, float rx, float ry, float width,
                        gfx_rgb_t c, float alpha, const gfx_mask_t *clip);
/* A disc coloured per pixel by `shader`. */
void gfx_fill_disc_shaded(gfx_fb_t *fb, float cx, float cy, float r, gfx_shader_t shader,
                          void *ctx);
/* Thick line with round caps. */
void gfx_capsule(gfx_fb_t *fb, float x1, float y1, float x2, float y2, float width, gfx_rgb_t c,
                 float alpha, const gfx_mask_t *clip);
/* Quadratic curve from p0 through control c to p1, stroked with round caps. */
void gfx_quad(gfx_fb_t *fb, gfx_pt_t p0, gfx_pt_t c, gfx_pt_t p1, float width, gfx_rgb_t col,
              float alpha, const gfx_mask_t *clip);
/* Ring segment from angle a0 to a1 (radians, 0 = 3 o'clock, clockwise on screen), round caps. */
void gfx_arc(gfx_fb_t *fb, float cx, float cy, float r, float width, float a0, float a1,
             gfx_rgb_t c, float alpha, const gfx_mask_t *clip);

void gfx_poly_begin(gfx_poly_t *poly, gfx_pt_t p);
void gfx_poly_line(gfx_poly_t *poly, gfx_pt_t p);
void gfx_poly_quad(gfx_poly_t *poly, gfx_pt_t c, gfx_pt_t p, int segments);
void gfx_poly_cubic(gfx_poly_t *poly, gfx_pt_t c1, gfx_pt_t c2, gfx_pt_t p, int segments);
void gfx_fill_poly(gfx_fb_t *fb, const gfx_poly_t *poly, gfx_rgb_t c, float alpha,
                   const gfx_mask_t *clip);
/* Outline of a closed polygon. */
void gfx_stroke_poly(gfx_fb_t *fb, const gfx_poly_t *poly, float width, gfx_rgb_t c, float alpha,
                     const gfx_mask_t *clip);

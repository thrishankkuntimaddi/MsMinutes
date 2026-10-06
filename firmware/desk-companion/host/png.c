#include "png.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t crc_table[256];

static void crc_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    crc_table[n] = c;
  }
}

static uint32_t crc32(uint32_t crc, const uint8_t *buf, size_t len) {
  crc ^= 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) crc = crc_table[(crc ^ buf[i]) & 0xFF] ^ (crc >> 8);
  return crc ^ 0xFFFFFFFFu;
}

static void be32(uint8_t *out, uint32_t v) {
  out[0] = (uint8_t)(v >> 24);
  out[1] = (uint8_t)(v >> 16);
  out[2] = (uint8_t)(v >> 8);
  out[3] = (uint8_t)v;
}

static bool chunk(FILE *f, const char *type, const uint8_t *data, size_t len) {
  uint8_t head[8];
  be32(head, (uint32_t)len);
  memcpy(head + 4, type, 4);
  uint32_t crc = crc32(0, head + 4, 4);
  crc = crc32(crc, data, len);
  uint8_t tail[4];
  be32(tail, crc);
  return fwrite(head, 1, 8, f) == 8 && (len == 0 || fwrite(data, 1, len, f) == len) &&
         fwrite(tail, 1, 4, f) == 4;
}

bool png_write_rgb565(const char *path, int w, int h, const uint16_t *px) {
  crc_init();
  size_t row = (size_t)w * 3 + 1;
  size_t raw_len = row * (size_t)h;
  uint8_t *raw = malloc(raw_len);
  if (!raw) return false;
  for (int y = 0; y < h; y++) {
    uint8_t *r = raw + row * (size_t)y;
    *r++ = 0; /* filter: none */
    for (int x = 0; x < w; x++) {
      uint16_t c = px[y * w + x];
      *r++ = (uint8_t)(((c >> 11) & 0x1F) * 255 / 31);
      *r++ = (uint8_t)(((c >> 5) & 0x3F) * 255 / 63);
      *r++ = (uint8_t)((c & 0x1F) * 255 / 31);
    }
  }

  /* zlib stream of stored blocks (max 65535 bytes each). */
  size_t blocks = (raw_len + 65534) / 65535;
  size_t z_len = 2 + raw_len + blocks * 5 + 4;
  uint8_t *z = malloc(z_len);
  if (!z) {
    free(raw);
    return false;
  }
  size_t o = 0;
  z[o++] = 0x78;
  z[o++] = 0x01;
  size_t at = 0;
  uint32_t a = 1, b = 0;
  for (size_t i = 0; i < raw_len; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  while (at < raw_len) {
    size_t n = raw_len - at > 65535 ? 65535 : raw_len - at;
    z[o++] = at + n == raw_len ? 1 : 0;
    z[o++] = (uint8_t)(n & 0xFF);
    z[o++] = (uint8_t)(n >> 8);
    z[o++] = (uint8_t)(~n & 0xFF);
    z[o++] = (uint8_t)((~n >> 8) & 0xFF);
    memcpy(z + o, raw + at, n);
    o += n;
    at += n;
  }
  be32(z + o, (b << 16) | a);
  o += 4;

  FILE *f = fopen(path, "wb");
  bool ok = f != NULL;
  if (ok) {
    static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
    uint8_t ihdr[13];
    be32(ihdr, (uint32_t)w);
    be32(ihdr + 4, (uint32_t)h);
    ihdr[8] = 8;  /* bit depth */
    ihdr[9] = 2;  /* truecolour */
    ihdr[10] = 0; /* compression */
    ihdr[11] = 0; /* filter */
    ihdr[12] = 0; /* interlace */
    ok = fwrite(sig, 1, 8, f) == 8 && chunk(f, "IHDR", ihdr, 13) && chunk(f, "IDAT", z, o) &&
         chunk(f, "IEND", NULL, 0);
    ok = fclose(f) == 0 && ok;
  }
  free(z);
  free(raw);
  return ok;
}

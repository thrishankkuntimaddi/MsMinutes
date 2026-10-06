#include "b64.h"

static const char ALPHABET[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t b64_encoded_size(size_t n) { return ((n + 2) / 3) * 4 + 1; }

size_t b64_encode(const uint8_t *in, size_t n, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < n) v |= in[i + 2];
    out[o++] = ALPHABET[(v >> 18) & 63];
    out[o++] = ALPHABET[(v >> 12) & 63];
    out[o++] = i + 1 < n ? ALPHABET[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? ALPHABET[v & 63] : '=';
  }
  out[o] = '\0';
  return o;
}

size_t b64_decoded_cap(size_t len) { return (len / 4 + 1) * 3; }

static int value_of(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

size_t b64_decode(const char *in, size_t len, uint8_t *out) {
  while (len > 0 && in[len - 1] == '=') len--;
  size_t o = 0;
  uint32_t acc = 0;
  int bits = 0;
  for (size_t i = 0; i < len; i++) {
    int v = value_of(in[i]);
    if (v < 0) return 0;
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (uint8_t)((acc >> bits) & 0xFF);
    }
  }
  return o;
}

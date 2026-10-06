/* Standard base64 with padding, for audio in the Body Protocol's JSON frames. */
#pragma once

#include <stddef.h>
#include <stdint.h>

/* Bytes needed for `n` input bytes, including the terminating NUL. */
size_t b64_encoded_size(size_t n);
/* Writes NUL-terminated base64 into `out` (at least b64_encoded_size(n)); returns its length. */
size_t b64_encode(const uint8_t *in, size_t n, char *out);
/* Upper bound on decoded bytes for `len` base64 characters. */
size_t b64_decoded_cap(size_t len);
/* Returns the number of bytes written, or 0 on malformed input (empty input decodes to 0). */
size_t b64_decode(const char *in, size_t len, uint8_t *out);

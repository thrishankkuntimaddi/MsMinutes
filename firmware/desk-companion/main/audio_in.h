#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One second of 16 kHz PCM16 is ready to go to the brain, `seq` counting from 0. */
typedef void (*audio_in_chunk_cb)(const int16_t *pcm, size_t samples, int seq, void *ctx);
/* The utterance ended (button released, or the limit was reached) after `chunks` chunks. */
typedef void (*audio_in_end_cb)(int chunks, void *ctx);

void audio_in_init(audio_in_chunk_cb on_chunk, audio_in_end_cb on_end, void *ctx);
/* Push-to-talk: start capturing (the button went down). */
void audio_in_start(void);
/* Stop capturing (the button came up); the last partial chunk and the end follow. */
void audio_in_stop(void);
bool audio_in_capturing(void);

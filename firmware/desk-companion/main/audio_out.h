#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "rig.h"

/* Her voice: PCM16 from the brain, played gap-free through the I2S amplifier. */
void audio_out_init(void);
/* Queues samples after whatever is playing. Drops them (with a log) if the buffer is full. */
void audio_out_push(const int16_t *pcm, size_t samples, int sample_rate);
/* Barge-in: stop now and forget what was queued. */
void audio_out_cancel(void);
bool audio_out_busy(void);
/* Mouth shape from how loud and how bright her voice is right now; false when silent. */
bool audio_out_viseme(rig_viseme_t *out);

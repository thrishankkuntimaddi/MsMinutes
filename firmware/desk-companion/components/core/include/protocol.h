/*
 * The Body Protocol (packages/protocol) in C: parse brain → body messages, build body → brain
 * ones. Mirrors the zod schemas; the host tests check it against packages/protocol/fixtures.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "rig.h"

#define PROTOCOL_VERSION 1
#define PROTO_ID_MAX 65

typedef enum {
  BRAIN_MSG_UNKNOWN = 0,
  BRAIN_MSG_WELCOME,
  BRAIN_MSG_STATE_SET,
  BRAIN_MSG_EXPRESSION_SET,
  BRAIN_MSG_SPEECH_TEXT_DELTA,
  BRAIN_MSG_SPEECH_AUDIO_CHUNK,
  BRAIN_MSG_SPEECH_MARKS,
  BRAIN_MSG_SPEECH_END,
  BRAIN_MSG_SPEECH_CANCEL,
  BRAIN_MSG_TRANSCRIPT,
  BRAIN_MSG_CAPABILITY_CALL,
  BRAIN_MSG_ERROR,
} brain_msg_type_t;

typedef enum {
  PROTO_OK = 0,
  PROTO_INVALID_JSON,
  PROTO_UNSUPPORTED_VERSION,
  PROTO_INVALID_MESSAGE,
} proto_result_t;

/* A parsed message. Strings point into `root`; free with protocol_free. */
typedef struct {
  brain_msg_type_t type;
  const char *id;
  const char *reply_to; /* NULL when absent */
  cJSON *root;
  cJSON *payload;
} brain_msg_t;

typedef struct {
  const char *session_id;
  const char *persona_name;
  int heartbeat_interval_ms;
  bool audio;   /* the brain streams her voice as speech.audio.chunk */
  bool hearing; /* the brain transcribes this body's event.audio.* */
} proto_welcome_t;

typedef struct {
  int affect; /* enum rig_affect */
  float intensity;
  int transition_ms;
  int blend_count;
  int blend_affects[4];
  float blend_weights[4];
} proto_expression_t;

typedef struct {
  const char *turn_id;
  int seq;
  int sample_rate;
  bool pcm16;
  const char *data; /* base64 */
  size_t data_len;
} proto_audio_chunk_t;

typedef struct {
  const char *call_id;
  const char *name;
  cJSON *args;
} proto_call_t;

typedef struct {
  const char *code;
  const char *message;
  bool fatal;
} proto_error_t;

proto_result_t protocol_parse(const char *text, size_t len, brain_msg_t *out);
/* Checks the payload has the shape its schema promises (what the brain's zod schemas reject). */
bool protocol_validate(const brain_msg_t *msg);
void protocol_free(brain_msg_t *msg);
const char *protocol_type_name(brain_msg_type_t type);

/* Typed views of the payload; false when the payload isn't the shape the schema promises. */
bool protocol_welcome(const brain_msg_t *msg, proto_welcome_t *out);
bool protocol_state(const brain_msg_t *msg, rig_mode_t *out);
bool protocol_expression(const brain_msg_t *msg, proto_expression_t *out);
bool protocol_audio_chunk(const brain_msg_t *msg, proto_audio_chunk_t *out);
bool protocol_turn_id(const brain_msg_t *msg, const char **out);
bool protocol_transcript(const brain_msg_t *msg, const char **out);
bool protocol_capability_call(const brain_msg_t *msg, proto_call_t *out);
bool protocol_error(const brain_msg_t *msg, proto_error_t *out);

/* Who this body is, and how it stamps envelopes. */
typedef struct {
  const char *body_id;
  uint64_t (*now_ms)(void);
  void (*uuid)(char out[37]);
} proto_env_t;

/*
 * Builders return a malloc'd JSON string (free() it), or NULL when out of memory.
 * `pcm_b64` for audio chunks is the already-encoded PCM16 data.
 */
char *protocol_hello(const proto_env_t *env, const char *body_type, const char *firmware,
                     bool has_mic, bool has_speaker);
char *protocol_heartbeat(const proto_env_t *env);
char *protocol_utterance_text(const proto_env_t *env, const char *text);
char *protocol_audio_chunk_msg(const proto_env_t *env, int seq, int sample_rate,
                               const char *pcm_b64);
char *protocol_audio_end(const proto_env_t *env);
char *protocol_interrupt(const proto_env_t *env);
char *protocol_sensor(const proto_env_t *env, const char *kind, cJSON *data /* consumed */);
char *protocol_capability_result(const proto_env_t *env, const char *call_id, bool ok,
                                 const char *error_code, const char *error_message);

#include "protocol.h"

#include <stdlib.h>
#include <string.h>

static const struct {
  const char *name;
  brain_msg_type_t type;
} TYPES[] = {
    {"welcome", BRAIN_MSG_WELCOME},
    {"state.set", BRAIN_MSG_STATE_SET},
    {"expression.set", BRAIN_MSG_EXPRESSION_SET},
    {"speech.text.delta", BRAIN_MSG_SPEECH_TEXT_DELTA},
    {"speech.audio.chunk", BRAIN_MSG_SPEECH_AUDIO_CHUNK},
    {"speech.marks", BRAIN_MSG_SPEECH_MARKS},
    {"speech.end", BRAIN_MSG_SPEECH_END},
    {"speech.cancel", BRAIN_MSG_SPEECH_CANCEL},
    {"transcript", BRAIN_MSG_TRANSCRIPT},
    {"capability.call", BRAIN_MSG_CAPABILITY_CALL},
    {"error", BRAIN_MSG_ERROR},
};

static const char *const MODES[] = {"idle", "listening", "thinking", "speaking", "timer_running"};

const char *protocol_type_name(brain_msg_type_t type) {
  for (size_t i = 0; i < sizeof TYPES / sizeof TYPES[0]; i++) {
    if (TYPES[i].type == type) return TYPES[i].name;
  }
  return "unknown";
}

static const char *str_of(const cJSON *obj, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

static bool num_of(const cJSON *obj, const char *key, double *out) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (!cJSON_IsNumber(v)) return false;
  *out = v->valuedouble;
  return true;
}

static bool bool_of(const cJSON *obj, const char *key, bool fallback) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsBool(v) ? cJSON_IsTrue(v) : fallback;
}

static bool valid_body_id(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 64) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool lower = c >= 'a' && c <= 'z', digit = c >= '0' && c <= '9';
    if (!(lower || digit || (i > 0 && (c == '-' || c == '_')))) return false;
  }
  return true;
}

proto_result_t protocol_parse(const char *text, size_t len, brain_msg_t *out) {
  memset(out, 0, sizeof(*out));
  cJSON *root = cJSON_ParseWithLength(text, len);
  if (!root) return PROTO_INVALID_JSON;
  out->root = root;
  if (!cJSON_IsObject(root)) return PROTO_INVALID_MESSAGE;

  double v;
  if (num_of(root, "v", &v) && v != PROTOCOL_VERSION) return PROTO_UNSUPPORTED_VERSION;
  if (!num_of(root, "v", &v)) return PROTO_INVALID_MESSAGE;

  out->id = str_of(root, "id");
  out->reply_to = str_of(root, "replyTo");
  const char *body_id = str_of(root, "bodyId");
  const char *type = str_of(root, "type");
  double ts;
  out->payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
  if (!out->id || !*out->id || strlen(out->id) > 64 || !body_id || !valid_body_id(body_id) ||
      !type || !num_of(root, "ts", &ts) || ts < 0 || !cJSON_IsObject(out->payload)) {
    return PROTO_INVALID_MESSAGE;
  }
  for (size_t i = 0; i < sizeof TYPES / sizeof TYPES[0]; i++) {
    if (strcmp(TYPES[i].name, type) == 0) {
      out->type = TYPES[i].type;
      return PROTO_OK;
    }
  }
  return PROTO_INVALID_MESSAGE;
}

bool protocol_validate(const brain_msg_t *msg) {
  switch (msg->type) {
    case BRAIN_MSG_WELCOME: {
      proto_welcome_t w;
      return protocol_welcome(msg, &w);
    }
    case BRAIN_MSG_STATE_SET: {
      rig_mode_t m;
      return protocol_state(msg, &m);
    }
    case BRAIN_MSG_EXPRESSION_SET: {
      proto_expression_t e;
      return protocol_expression(msg, &e);
    }
    case BRAIN_MSG_SPEECH_AUDIO_CHUNK: {
      proto_audio_chunk_t c;
      return protocol_audio_chunk(msg, &c);
    }
    case BRAIN_MSG_SPEECH_TEXT_DELTA:
    case BRAIN_MSG_SPEECH_MARKS:
    case BRAIN_MSG_SPEECH_END:
    case BRAIN_MSG_SPEECH_CANCEL: {
      const char *turn;
      return protocol_turn_id(msg, &turn);
    }
    case BRAIN_MSG_TRANSCRIPT: {
      const char *text;
      return protocol_transcript(msg, &text);
    }
    case BRAIN_MSG_CAPABILITY_CALL: {
      proto_call_t call;
      return protocol_capability_call(msg, &call);
    }
    case BRAIN_MSG_ERROR: {
      proto_error_t err;
      return protocol_error(msg, &err);
    }
    default:
      return false;
  }
}

void protocol_free(brain_msg_t *msg) {
  if (msg->root) cJSON_Delete(msg->root);
  memset(msg, 0, sizeof(*msg));
}

bool protocol_welcome(const brain_msg_t *msg, proto_welcome_t *out) {
  if (msg->type != BRAIN_MSG_WELCOME) return false;
  const cJSON *p = msg->payload;
  const cJSON *persona = cJSON_GetObjectItemCaseSensitive(p, "persona");
  double hb;
  out->session_id = str_of(p, "sessionId");
  out->persona_name = str_of(persona, "name");
  if (!out->session_id || !out->persona_name || !num_of(p, "heartbeatIntervalMs", &hb) || hb <= 0) {
    return false;
  }
  out->heartbeat_interval_ms = (int)hb;
  out->audio = bool_of(p, "audio", false);
  out->hearing = bool_of(p, "hearing", false);
  return true;
}

bool protocol_state(const brain_msg_t *msg, rig_mode_t *out) {
  if (msg->type != BRAIN_MSG_STATE_SET) return false;
  const char *mode = str_of(msg->payload, "mode");
  if (!mode) return false;
  for (size_t i = 0; i < sizeof MODES / sizeof MODES[0]; i++) {
    if (strcmp(MODES[i], mode) == 0) {
      *out = (rig_mode_t)i;
      return true;
    }
  }
  return false;
}

bool protocol_expression(const brain_msg_t *msg, proto_expression_t *out) {
  if (msg->type != BRAIN_MSG_EXPRESSION_SET) return false;
  const cJSON *p = msg->payload;
  double intensity, transition;
  out->affect = rig_affect_from_name(str_of(p, "affect"));
  if (out->affect < 0 || !num_of(p, "intensity", &intensity) || intensity < 0 || intensity > 1 ||
      !num_of(p, "transitionMs", &transition) || transition < 0) {
    return false;
  }
  out->intensity = (float)intensity;
  out->transition_ms = (int)transition;
  out->blend_count = 0;
  const cJSON *blend = cJSON_GetObjectItemCaseSensitive(p, "blend");
  if (cJSON_IsArray(blend)) {
    const cJSON *entry;
    cJSON_ArrayForEach(entry, blend) {
      if (out->blend_count == 4) return false;
      int affect = rig_affect_from_name(str_of(entry, "affect"));
      double weight;
      if (affect < 0 || !num_of(entry, "weight", &weight) || weight < 0 || weight > 1) return false;
      out->blend_affects[out->blend_count] = affect;
      out->blend_weights[out->blend_count++] = (float)weight;
    }
  }
  return true;
}

bool protocol_audio_chunk(const brain_msg_t *msg, proto_audio_chunk_t *out) {
  if (msg->type != BRAIN_MSG_SPEECH_AUDIO_CHUNK) return false;
  const cJSON *p = msg->payload;
  double seq, rate;
  const char *codec = str_of(p, "codec");
  out->turn_id = str_of(p, "turnId");
  out->data = str_of(p, "data");
  if (!out->turn_id || !codec || !out->data || !num_of(p, "seq", &seq) || seq < 0 ||
      !num_of(p, "sampleRate", &rate) || rate <= 0) {
    return false;
  }
  out->seq = (int)seq;
  out->sample_rate = (int)rate;
  out->pcm16 = strcmp(codec, "pcm16") == 0;
  out->data_len = strlen(out->data);
  return true;
}

bool protocol_turn_id(const brain_msg_t *msg, const char **out) {
  switch (msg->type) {
    case BRAIN_MSG_SPEECH_TEXT_DELTA:
    case BRAIN_MSG_SPEECH_AUDIO_CHUNK:
    case BRAIN_MSG_SPEECH_MARKS:
    case BRAIN_MSG_SPEECH_END:
    case BRAIN_MSG_SPEECH_CANCEL:
      *out = str_of(msg->payload, "turnId");
      return *out != NULL;
    default:
      return false;
  }
}

bool protocol_transcript(const brain_msg_t *msg, const char **out) {
  if (msg->type != BRAIN_MSG_TRANSCRIPT) return false;
  *out = str_of(msg->payload, "text");
  return *out != NULL;
}

bool protocol_capability_call(const brain_msg_t *msg, proto_call_t *out) {
  if (msg->type != BRAIN_MSG_CAPABILITY_CALL) return false;
  const cJSON *p = msg->payload;
  out->call_id = str_of(p, "callId");
  out->name = str_of(p, "name");
  out->args = cJSON_GetObjectItemCaseSensitive(p, "args");
  return out->call_id && out->name && cJSON_IsObject(out->args);
}

bool protocol_error(const brain_msg_t *msg, proto_error_t *out) {
  if (msg->type != BRAIN_MSG_ERROR) return false;
  const cJSON *p = msg->payload;
  out->code = str_of(p, "code");
  out->message = str_of(p, "message");
  out->fatal = bool_of(p, "fatal", false);
  return out->code && out->message;
}

/* ---------- body → brain ---------- */

static cJSON *envelope(const proto_env_t *env, const char *type, cJSON *payload) {
  char id[37];
  env->uuid(id);
  cJSON *root = cJSON_CreateObject();
  if (!root) {
    cJSON_Delete(payload);
    return NULL;
  }
  cJSON_AddNumberToObject(root, "v", PROTOCOL_VERSION);
  cJSON_AddStringToObject(root, "id", id);
  cJSON_AddStringToObject(root, "type", type);
  cJSON_AddStringToObject(root, "bodyId", env->body_id);
  cJSON_AddNumberToObject(root, "ts", (double)env->now_ms());
  cJSON_AddItemToObject(root, "payload", payload);
  return root;
}

static char *finish(cJSON *root) {
  if (!root) return NULL;
  char *text = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  return text;
}

static void add_capability(cJSON *list, const char *name, const char *description, int tier) {
  cJSON *c = cJSON_CreateObject();
  cJSON_AddStringToObject(c, "name", name);
  cJSON_AddStringToObject(c, "description", description);
  cJSON_AddNumberToObject(c, "riskTier", tier);
  cJSON_AddItemToArray(list, c);
}

char *protocol_hello(const proto_env_t *env, const char *body_type, const char *firmware,
                     bool has_mic, bool has_speaker) {
  cJSON *payload = cJSON_CreateObject();
  cJSON_AddStringToObject(payload, "bodyType", body_type);
  cJSON_AddStringToObject(payload, "firmware", firmware);
  cJSON *caps = cJSON_AddArrayToObject(payload, "capabilities");
  add_capability(caps, "express", "Show an emotion on her clock face", 0);
  if (has_speaker) add_capability(caps, "speak.audio", "Play her voice through the speaker", 0);
  if (has_mic) add_capability(caps, "listen", "Hear the user when they hold the talk button", 2);
  add_capability(caps, "display.timer", "Show running timers on her face", 0);
  add_capability(caps, "alarm.ring", "Ring her bells when a timer or reminder fires", 0);
  return finish(envelope(env, "hello", payload));
}

char *protocol_heartbeat(const proto_env_t *env) {
  return finish(envelope(env, "heartbeat", cJSON_CreateObject()));
}

char *protocol_utterance_text(const proto_env_t *env, const char *text) {
  cJSON *payload = cJSON_CreateObject();
  cJSON_AddStringToObject(payload, "text", text);
  return finish(envelope(env, "event.utterance.text", payload));
}

char *protocol_audio_chunk_msg(const proto_env_t *env, int seq, int sample_rate,
                               const char *pcm_b64) {
  cJSON *payload = cJSON_CreateObject();
  cJSON_AddNumberToObject(payload, "seq", seq);
  cJSON_AddStringToObject(payload, "codec", "pcm16");
  cJSON_AddNumberToObject(payload, "sampleRate", sample_rate);
  cJSON_AddStringToObject(payload, "data", pcm_b64);
  return finish(envelope(env, "event.audio.chunk", payload));
}

char *protocol_audio_end(const proto_env_t *env) {
  return finish(envelope(env, "event.audio.end", cJSON_CreateObject()));
}

char *protocol_interrupt(const proto_env_t *env) {
  return finish(envelope(env, "event.interrupt", cJSON_CreateObject()));
}

char *protocol_sensor(const proto_env_t *env, const char *kind, cJSON *data) {
  cJSON *payload = cJSON_CreateObject();
  cJSON_AddStringToObject(payload, "kind", kind);
  cJSON_AddItemToObject(payload, "data", data ? data : cJSON_CreateObject());
  return finish(envelope(env, "event.sensor", payload));
}

char *protocol_capability_result(const proto_env_t *env, const char *call_id, bool ok,
                                 const char *error_code, const char *error_message) {
  cJSON *payload = cJSON_CreateObject();
  cJSON_AddStringToObject(payload, "callId", call_id);
  cJSON_AddBoolToObject(payload, "ok", ok);
  if (!ok) {
    cJSON *err = cJSON_AddObjectToObject(payload, "error");
    cJSON_AddStringToObject(err, "code", error_code ? error_code : "failed");
    cJSON_AddStringToObject(err, "message", error_message ? error_message : "");
  }
  return finish(envelope(env, "capability.result", payload));
}

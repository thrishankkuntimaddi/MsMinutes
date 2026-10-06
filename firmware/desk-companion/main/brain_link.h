#pragma once

#include <stdbool.h>

#include "app.h"
#include "protocol.h"

typedef struct {
  /* A valid brain message. Runs on the link's task; the message is freed afterwards. */
  void (*on_message)(const brain_msg_t *msg, void *ctx);
  void (*on_status)(link_status_t status, void *ctx);
  void *ctx;
} brain_link_handlers_t;

/* Connects to the brain, says hello, keeps heartbeats going and reconnects when it drops. */
void brain_link_start(const brain_link_handlers_t *handlers);
/* Sends one JSON message (takes a malloc'd string from the protocol builders and frees it). */
bool brain_link_send(char *json);
bool brain_link_online(void);
const proto_env_t *brain_link_env(void);

/* Shared by every module of the desk companion firmware. */
#pragma once

#include <stdbool.h>

#define FIRMWARE_VERSION "0.1.0"
#define BODY_TYPE "desk_companion"

typedef enum { LINK_OFFLINE = 0, LINK_CONNECTING, LINK_ONLINE } link_status_t;

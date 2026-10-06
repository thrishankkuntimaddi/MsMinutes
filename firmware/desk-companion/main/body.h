#pragma once

#include <stdbool.h>

/*
 * The body: her face on the display, the brain's directives applied to the rig, her voice
 * to the speaker, the talk button to her ears. Everything else is plumbing.
 */
void body_start(void);
/* Wi-Fi came or went; the brain link starts the first time it comes. */
void body_wifi_changed(bool connected);

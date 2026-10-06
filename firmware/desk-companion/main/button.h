#pragma once

typedef void (*button_cb)(void *ctx);

/* The talk button: debounced; `on_press` when it goes down, `on_release` when it comes up. */
void button_init(button_cb on_press, button_cb on_release, void *ctx);

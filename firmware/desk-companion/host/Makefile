# Builds and tests the firmware's portable core (firmware/desk-companion/core) on the host:
# the rig, her face, base64 and the protocol codec need no ESP-IDF, so CI checks them with
# a plain C compiler, and `render_poses` draws her pose sheet for a look.
#
#   make check         build, run the tests against packages/protocol/fixtures, draw poses.png
#   make clean

CC ?= cc
CFLAGS ?= -std=c11 -O2 -g -Wall -Wextra -Werror
CORE := ../components/core
BUILD := build
THIRD := $(BUILD)/third_party
FIXTURES := ../../../packages/protocol/fixtures

# cJSON ships with ESP-IDF; on the host we fetch the same library once.
CJSON_VERSION := v1.7.18
CJSON_URL := https://raw.githubusercontent.com/DaveGamble/cJSON/$(CJSON_VERSION)

INC := -I$(CORE)/include -I$(THIRD)
CORE_SRC := $(CORE)/rig.c $(CORE)/rig_presets.c $(CORE)/gfx.c $(CORE)/face.c $(CORE)/b64.c \
            $(CORE)/protocol.c
CORE_OBJ := $(patsubst $(CORE)/%.c,$(BUILD)/core_%.o,$(CORE_SRC))

.PHONY: all check clean poses

all: $(BUILD)/test_core $(BUILD)/render_poses

check: all
	./$(BUILD)/test_core $(FIXTURES)
	./$(BUILD)/render_poses $(BUILD)/poses.png

poses: $(BUILD)/render_poses
	./$(BUILD)/render_poses $(BUILD)/poses.png

$(BUILD) $(THIRD):
	mkdir -p $@

$(THIRD)/cJSON.c $(THIRD)/cJSON.h: | $(THIRD)
	curl -fsSL -o $@ $(CJSON_URL)/$(notdir $@)

$(BUILD)/core_%.o: $(CORE)/%.c $(CORE)/include/*.h $(THIRD)/cJSON.h | $(BUILD)
	$(CC) $(CFLAGS) $(INC) -c -o $@ $<

$(BUILD)/cJSON.o: $(THIRD)/cJSON.c $(THIRD)/cJSON.h
	$(CC) -std=c11 -O2 -w $(INC) -c -o $@ $<

$(BUILD)/png.o: png.c png.h | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/test_core: test_core.c $(CORE_OBJ) $(BUILD)/cJSON.o $(BUILD)/png.o
	$(CC) $(CFLAGS) $(INC) -o $@ $^ -lm

$(BUILD)/render_poses: render_poses.c $(CORE_OBJ) $(BUILD)/cJSON.o $(BUILD)/png.o
	$(CC) $(CFLAGS) $(INC) -o $@ $^ -lm

clean:
	rm -rf $(BUILD)

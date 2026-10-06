# Her rig, her face, base64 and the protocol codec: portable C shared with the host tests.
idf_component_register(
  SRCS rig.c rig_presets.c gfx.c face.c b64.c protocol.c
  INCLUDE_DIRS include
  REQUIRES json)

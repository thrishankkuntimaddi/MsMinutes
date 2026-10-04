// Emits JSON Schema for non-TypeScript bodies (ESP32 firmware, mobile).
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { BodyToBrainMessage, BrainToBodyMessage } from "../src/index.js";

const outDir = new URL("../schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const schemas = { "body-to-brain": BodyToBrainMessage, "brain-to-body": BrainToBodyMessage };
for (const [name, schema] of Object.entries(schemas)) {
  const file = new URL(`${name}.schema.json`, outDir);
  writeFileSync(file, JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n");
  console.log(`wrote ${file.pathname}`);
}

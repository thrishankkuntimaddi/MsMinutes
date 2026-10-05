import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const brain = process.env.BRAIN_ORIGIN ?? "http://127.0.0.1:7700";

/**
 * Serves the voice-activity detector's model, worklet and ONNX runtime files at /vad/
 * (and copies them into builds), so hands-free listening works offline.
 */
function vadAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const vadIndex = require.resolve("@ricky0123/vad-web");
  const vadDir = dirname(vadIndex);
  const ortDir = dirname(createRequire(vadIndex).resolve("onnxruntime-web/wasm"));
  const wanted = (name: string) =>
    /^(vad\.worklet\.bundle\.min\.js|silero_vad_(v5|legacy)\.onnx)$/.test(name) ||
    /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(name);
  const find = (name: string) =>
    [vadDir, ortDir].map((d) => join(d, name)).find((p) => wanted(name) && existsSync(p));
  return {
    name: "vad-assets",
    configureServer(server) {
      server.middlewares.use("/vad/", (req, res, next) => {
        const file = find(decodeURIComponent((req.url ?? "").split("?")[0]!.slice(1)));
        if (!file) return next();
        const type = file.endsWith(".wasm")
          ? "application/wasm"
          : file.endsWith(".onnx")
            ? "application/octet-stream"
            : "text/javascript";
        res.setHeader("Content-Type", type);
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of [vadDir, ortDir]) {
        for (const name of readdirSync(dir).filter(wanted)) {
          this.emitFile({
            type: "asset",
            fileName: `vad/${name}`,
            source: readFileSync(join(dir, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [vadAssets()],
  server: {
    port: 5179,
    // The page talks to the brain on its own origin; Vite forwards the socket.
    proxy: { "/ws": { target: brain, ws: true }, "/api": { target: brain } },
  },
});

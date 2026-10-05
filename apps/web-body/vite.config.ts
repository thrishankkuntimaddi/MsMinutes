import { defineConfig } from "vite";

const brain = process.env.BRAIN_ORIGIN ?? "http://127.0.0.1:7700";

export default defineConfig({
  server: {
    port: 5179,
    // The page talks to the brain on its own origin; Vite forwards the socket.
    proxy: { "/ws": { target: brain, ws: true } },
  },
});

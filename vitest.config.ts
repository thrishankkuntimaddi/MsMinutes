import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Memory and skills tests run real (embedded) Postgres; give them room on a busy machine.
    testTimeout: 20_000,
  },
});

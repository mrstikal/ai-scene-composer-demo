import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/test/unit/**/*.test.ts", "src/test/integration/**/*.test.ts"],
    exclude: ["src/test/e2e/**", "node_modules/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      AI_MODE: "mock",
      SAM_MODE: "fixture",
      RUN_LIVE_AI_TESTS: "0",
    },
  },
});

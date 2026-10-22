import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defineConfig } from "@playwright/test";

import { createDatabase } from "./src/lib/db/client";
import { migrateDatabase } from "./src/lib/db/migrate";

for (const entry of readdirSync(tmpdir())) {
  if (!entry.startsWith("scene-composer-e2e-")) continue;
  const candidate = join(tmpdir(), entry);
  try {
    if (Date.now() - statSync(candidate).mtimeMs > 60 * 60 * 1000) {
      rmSync(candidate, { recursive: true, force: true });
    }
  } catch {
    continue;
  }
}

const testRoot = mkdtempSync(join(tmpdir(), "scene-composer-e2e-"));
const databasePath = join(testRoot, "e2e.sqlite");
const assetDir = join(testRoot, "assets");

const handle = createDatabase(databasePath);
migrateDatabase(handle.db);
handle.close();

const rootMarker = join(process.cwd(), "node_modules", ".cache", "scene-composer-e2e-root.txt");
mkdirSync(dirname(rootMarker), { recursive: true });
writeFileSync(rootMarker, testRoot);

const testEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ),
  AI_MODE: "mock",
  SAM_MODE: "fixture",
  RUN_LIVE_AI_TESTS: "0",
  OPENROUTER_API_KEY: "",
  META_MODEL_API_KEY: "",
  DATABASE_PATH: databasePath,
  ASSET_DIR: assetDir,
  PROJECT_BUDGET_USD: "5",
  IMAGE_RESERVATION_USD: "0.25",
};

export default defineConfig({
  testDir: "./src/test/e2e",
  globalTeardown: "./src/test/e2e/global-teardown.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
  },
  webServer: [
    {
      name: "worker",
      command: "npm run worker",
      cwd: process.cwd(),
      env: testEnv,
      stdout: "pipe",
      stderr: "pipe",
      wait: { stdout: /^SCENE_WORKER_READY$/m },
      timeout: 60000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
    {
      name: "app",
      command: "npm run dev -- --port 3100",
      cwd: process.cwd(),
      env: testEnv,
      stdout: "pipe",
      stderr: "pipe",
      url: "http://127.0.0.1:3100/api/health",
      timeout: 120000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    },
  ],
});

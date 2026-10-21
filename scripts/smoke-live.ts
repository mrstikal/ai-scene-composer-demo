import nextEnv from "@next/env";

import { parseEnv } from "../src/lib/config/env";

function main(): void {
  nextEnv.loadEnvConfig(process.cwd());
  const env = parseEnv(process.env, process.cwd());

  if (env.runLiveAiTests !== "1" || env.aiMode !== "live") {
    throw new Error(
      "Live smoke tests require RUN_LIVE_AI_TESTS=1 and AI_MODE=live. No network calls were made.",
    );
  }

  throw new Error(
    "The live smoke suite is implemented in a later phase. No provider calls were made.",
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Live smoke tests failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

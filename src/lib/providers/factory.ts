import { join } from "node:path";

import type { AppEnv } from "../config/env";
import { AppError } from "../errors";
import { mockGenerate } from "./mocks";
import { callOpenRouterGeneration } from "./openrouter";
import type { ImageGenerationAdapter, ImageGenerationInput } from "./types";

export function createGenerationAdapter(
  env: AppEnv,
  executionMode: "mock" | "live",
): ImageGenerationAdapter {
  if (executionMode === "mock") {
    return {
      generate: (input: ImageGenerationInput) =>
        mockGenerate({
          fixturePath: join(env.repoRoot, "src/test/fixtures/synthetic/living-room-v1.png"),
          prompt: input.prompt,
        }),
    };
  }

  const apiKey = env.openRouterApiKey;
  if (apiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
  }

  return {
    generate: (input: ImageGenerationInput) =>
      callOpenRouterGeneration({
        apiKey,
        prompt: input.prompt,
      }),
  };
}

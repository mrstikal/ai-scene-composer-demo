import { join } from "node:path";

import type { AppEnv } from "../config/env";
import { AppError } from "../errors";
import { mockEdit, mockGenerate, mockSegment } from "./mocks";
import { callOpenRouterGeneration, callOpenRouterImage } from "./openrouter";
import { callMetaSam } from "./sam";
import type {
  ImageEditAdapter,
  ImageGenerationAdapter,
  ImageGenerationInput,
  SegmentationAdapter,
} from "./types";

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

export function createEditAdapter(
  env: AppEnv,
  executionMode: "mock" | "live",
): ImageEditAdapter {
  if (executionMode === "mock") {
    return { edit: mockEdit };
  }

  const apiKey = env.openRouterApiKey;
  if (apiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
  }

  return {
    edit: (input) => callOpenRouterImage({ ...input, apiKey }),
  };
}

export function createSegmentationAdapter(
  env: AppEnv,
  executionMode: "mock" | "live",
): SegmentationAdapter {
  if (executionMode === "mock") {
    return { segment: mockSegment };
  }

  const apiKey = env.metaModelApiKey;
  if (apiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "Meta SAM is not configured.");
  }

  return {
    segment: (input) => callMetaSam({ ...input, apiKey }),
  };
}

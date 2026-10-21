import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/config/env";
import {
  assertCompatibleConfig,
  getPricingConfig,
  getProviderCapabilities,
  getPublicPricing,
  resetConfigCacheForTests,
} from "@/lib/config/pricing";

const repoRoot = process.cwd();

describe("environment configuration", () => {
  it("uses mock defaults and resolves paths from the repository root", () => {
    const env = parseEnv({}, repoRoot);
    expect(env.aiMode).toBe("mock");
    expect(env.samMode).toBe("fixture");
    expect(env.runLiveAiTests).toBe("0");
    expect(env.databasePath).toBe(`${repoRoot}/data/scene-composer.sqlite`);
    expect(env.assetDir).toBe(`${repoRoot}/assets-local`);
    expect(env.projectBudgetUsdMicros).toBe(5_000_000);
    expect(env.imageReservationUsdMicros).toBe(250_000);
  });

  it("rejects invalid enum values with expected choices and not the supplied value", () => {
    expect(() => parseEnv({ AI_MODE: "sometimes" }, repoRoot)).toThrow(
      "Invalid AI_MODE. Expected mock or live.",
    );
    expect(() => parseEnv({ SAM_MODE: "maybe" }, repoRoot)).toThrow(
      "Invalid SAM_MODE. Expected fixture or live.",
    );
    expect(() => parseEnv({ RUN_LIVE_AI_TESTS: "true" }, repoRoot)).toThrow(
      "Invalid RUN_LIVE_AI_TESTS. Expected 0 or 1.",
    );
  });

  it("rejects invalid money values", () => {
    expect(() => parseEnv({ PROJECT_BUDGET_USD: "0" }, repoRoot)).toThrow(
      "Invalid PROJECT_BUDGET_USD. Expected a positive USD amount.",
    );
    expect(() => parseEnv({ IMAGE_RESERVATION_USD: "abc" }, repoRoot)).toThrow(
      "Invalid IMAGE_RESERVATION_USD. Expected a positive USD amount.",
    );
  });

  it("rejects identical database and asset paths", () => {
    expect(() =>
      parseEnv({ DATABASE_PATH: "./same", ASSET_DIR: "./same" }, repoRoot),
    ).toThrow("Invalid DATABASE_PATH and ASSET_DIR. They must be different paths.");
  });
});

describe("pricing and provider configuration", () => {
  it("validates the dated pricing version and matching capability version", () => {
    resetConfigCacheForTests();
    assertCompatibleConfig();
    const pricing = getPricingConfig();
    const capabilities = getProviderCapabilities();
    expect(pricing.version).toMatch(/^\d{4}-\d{2}-\d{2}-v[1-9]\d*$/);
    expect(pricing.version).toBe("2026-10-21-v1");
    expect(pricing.capabilityVersion).toBe(capabilities.version);
    expect(pricing.currency).toBe("USD");
  });

  it("freezes unsupported provider contract features", () => {
    const capabilities = getProviderCapabilities();
    expect(capabilities.contractFreeze.nativeMaskParameter).toBe(false);
    expect(capabilities.contractFreeze.exactSizeParameter).toBe(false);
    expect(capabilities.contractFreeze.outputFormatParameter).toBe(false);
    expect(capabilities.contractFreeze.promptRewriter).toBe(false);
    expect(capabilities.contractFreeze.providerFallback).toBe(false);
    expect(capabilities.contractFreeze.additionalImageModels).toBe(false);
    expect(capabilities.contractFreeze.additionalImageProviders).toBe(false);
    expect(capabilities.contractFreeze.streamingImageResponse).toBe(false);
    expect(capabilities.contractFreeze.automaticRetries).toBe(false);
  });

  it("exposes only safe pricing fields", () => {
    const pricing = getPublicPricing();
    expect(pricing.reservations.imageUsdMicros).toBe(250_000);
    expect(pricing.reservations.comparisonUsdMicros).toBe(500_000);
    expect(pricing.reservations.segmentationUsdMicros).toBe(2_500);
    expect(pricing.models).toHaveLength(2);
    expect(pricing.models.map((model) => model.id).sort()).toEqual([
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.5-sunburst",
    ]);
  });
});

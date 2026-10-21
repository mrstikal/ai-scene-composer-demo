import { z } from "zod";

import pricingJson from "../../config/pricing.json";
import capabilitiesJson from "../../config/provider-capabilities.json";
import type { PublicPricingDto } from "../contracts/api";
import { AppError } from "../errors";

const rateSchema = z
  .object({
    billable: z.string().min(1),
    unit: z.string().min(1),
  })
  .passthrough();

const modelSchema = z
  .object({
    displayName: z.string().min(1),
    rates: z.array(rateSchema).min(1),
    billingRule: z.string().min(1),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

const pricingSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}-v[1-9]\d*$/),
    checkedAt: z.string().min(1),
    currency: z.literal("USD"),
    capabilityVersion: z.string().min(1),
    evidenceKind: z.literal("public-documentation"),
    reservations: z.object({
      projectBudget: z.object({ usd: z.number().positive(), usdMicros: z.number().int().positive() }),
      image: z.object({ usd: z.number().positive(), usdMicros: z.number().int().positive() }),
      comparison: z.object({ usd: z.number().positive(), usdMicros: z.number().int().positive() }),
      segmentation: z.object({ usd: z.number().positive(), usdMicros: z.number().int().positive() }),
    }),
    providers: z.object({
      openrouter: z.object({
        sourceUrls: z.array(z.string().url()).min(1),
        models: z.record(z.string(), modelSchema),
      }),
      meta: z.object({
        sourceUrls: z.array(z.string().url()).min(1),
        model: z.string().min(1),
        rates: z.array(rateSchema).min(1),
        billingRule: z.string().min(1),
      }),
    }),
  })
  .passthrough();

const capabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    checkedAt: z.string().min(1),
    contractFreeze: z.object({
      nativeMaskParameter: z.literal(false),
      exactSizeParameter: z.literal(false),
      outputFormatParameter: z.literal(false),
      promptRewriter: z.literal(false),
      providerFallback: z.literal(false),
      additionalImageModels: z.literal(false),
      additionalImageProviders: z.literal(false),
      streamingImageResponse: z.literal(false),
      automaticRetries: z.literal(false),
    }),
    openrouter: z.object({
      api: z.object({
        imagesEndpoint: z.literal("https://openrouter.ai/api/v1/images"),
      }),
      models: z.record(z.string(), z.unknown()),
    }),
    metaSam: z.object({
      model: z.literal("sam-3.1"),
      parser: z.object({
        package: z.literal("@meta-sam/parser"),
        verifiedVersion: z.string().min(1),
      }),
    }),
  })
  .passthrough();

export type PricingConfig = z.infer<typeof pricingSchema>;
export type ProviderCapabilities = z.infer<typeof capabilitiesSchema>;

let cachedPricing: PricingConfig | null = null;
let cachedCapabilities: ProviderCapabilities | null = null;

export function getPricingConfig(): PricingConfig {
  if (cachedPricing === null) {
    const parsed = pricingSchema.safeParse(pricingJson);
    if (!parsed.success) {
      throw new AppError(500, "CONFIG_INVALID", "Invalid pricing configuration.");
    }
    cachedPricing = parsed.data;
  }
  return cachedPricing;
}

export function getProviderCapabilities(): ProviderCapabilities {
  if (cachedCapabilities === null) {
    const parsed = capabilitiesSchema.safeParse(capabilitiesJson);
    if (!parsed.success) {
      throw new AppError(500, "CONFIG_INVALID", "Invalid provider capability configuration.");
    }
    cachedCapabilities = parsed.data;
  }
  return cachedCapabilities;
}

export function assertCompatibleConfig(): void {
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();
  if (pricing.capabilityVersion !== capabilities.version) {
    throw new AppError(500, "CONFIG_INVALID", "Pricing and provider capability versions do not match.");
  }
}

export function getPublicPricing(): PublicPricingDto {
  const pricing = getPricingConfig();
  return {
    version: pricing.version,
    currency: pricing.currency,
    reservations: {
      projectBudgetUsdMicros: pricing.reservations.projectBudget.usdMicros,
      imageUsdMicros: pricing.reservations.image.usdMicros,
      comparisonUsdMicros: pricing.reservations.comparison.usdMicros,
      segmentationUsdMicros: pricing.reservations.segmentation.usdMicros,
    },
    models: Object.entries(pricing.providers.openrouter.models).map(([id, model]) => ({
      id,
      displayName: model.displayName,
      rates: model.rates,
    })),
  };
}

export function resetConfigCacheForTests(): void {
  cachedPricing = null;
  cachedCapabilities = null;
}

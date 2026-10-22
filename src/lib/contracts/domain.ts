import { z } from "zod";

import { SCENE_PRESET_IDS } from "../../config/scene-presets";

export const pointSchema = z.object({
  x: z.number().int().min(0).max(1023),
  y: z.number().int().min(0).max(1023),
});

export type Point = z.infer<typeof pointSchema>;

export const SAM_MODEL = "sam-3.1" as const;
export const SAM_PROMPT_VERSION = "sam-prompt-v1" as const;
export const SAM_PARSER_VERSION = "0.1.0" as const;
export const MASK_PIPELINE_VERSION = "mask-pipeline-v1" as const;
export const MASK_FEATHER_PX = 8 as const;
export const MASK_PADDING_OPTIONS = [16, 32] as const;
export const EDIT_MODELS = [
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-2.5-sunburst",
] as const;
export const COMPARISON_MODELS = [
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-2.5-sunburst",
] as const;
export const EDIT_PROMPT_VERSION = "edit-prompt-v1" as const;
export const COMPOSITE_PIPELINE_VERSION = "composite-v1" as const;

export type MaskPaddingPx = (typeof MASK_PADDING_OPTIONS)[number];
export type EditModel = (typeof EDIT_MODELS)[number];
export type ComparisonModel = (typeof COMPARISON_MODELS)[number];

export const boundsSchema = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    right: z.number().int().nonnegative(),
    bottom: z.number().int().nonnegative(),
  })
  .strict();

export type Bounds = z.infer<typeof boundsSchema>;

export const regionPercentagesSchema = z
  .object({
    left: z.number().min(0).max(100),
    top: z.number().min(0).max(100),
    right: z.number().min(0).max(100),
    bottom: z.number().min(0).max(100),
  })
  .strict();

export type RegionPercentages = z.infer<typeof regionPercentagesSchema>;

export const samMaskPayloadSchema = z
  .object({
    encoding: z.enum(["lossless", "one_bit"]),
    payload: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export type SamMaskPayload = z.infer<typeof samMaskPayloadSchema>;

export const samMaskRecordSchema = z
  .object({
    objectId: z.string().min(1),
    box: boundsSchema,
    bounds: boundsSchema,
    mask: samMaskPayloadSchema,
  })
  .strict();

export type SamMaskRecord = z.infer<typeof samMaskRecordSchema>;

export const samCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceKind: z.literal("captured-live"),
    sourceCanonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.literal(1024),
    height: z.literal(1024),
    normalizationVersion: z.literal("normalization-v1"),
    positivePoints: z.array(pointSchema).length(1),
    negativePoints: z.array(pointSchema).max(1),
    model: z.literal(SAM_MODEL),
    captureDate: z.string().min(1),
    providerRequestId: z.string().nullable(),
    providerLatencyMs: z.number().int().nonnegative().nullable(),
    observedCostUsdMicros: z.number().int().nonnegative().nullable(),
    records: z.array(samMaskRecordSchema).min(1),
  })
  .strict();

export type SamCapture = z.infer<typeof samCaptureSchema>;

export const segmentSnapshotSchema = z
  .object({
    operation: z.literal("segment"),
    sourceVersionId: z.string().uuid(),
    sourceAssetId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.literal(1024),
    height: z.literal(1024),
    positivePoints: z.array(pointSchema).length(1),
    negativePoints: z.array(pointSchema).max(1),
    prompt: z.string().min(1).max(2000),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    promptVersion: z.literal(SAM_PROMPT_VERSION),
    model: z.literal(SAM_MODEL),
    executionMode: z.enum(["live", "mock", "fixture"]),
    parserVersion: z.string().min(1),
    normalizationVersion: z.literal("normalization-v1"),
    pricingVersion: z.string().min(1),
    capabilityVersion: z.string().min(1),
    reservationUsdMicros: z.number().int().nonnegative(),
    capture: z
      .object({
        relativePath: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SegmentSnapshot = z.infer<typeof segmentSnapshotSchema>;

export const editTransportOptionsSchema = z
  .object({
    aspectRatio: z.literal("1:1"),
    quality: z.literal("medium"),
    background: z.literal("opaque"),
    n: z.literal(1),
    provider: z
      .object({
        only: z.tuple([z.literal("openai")]),
        allowFallbacks: z.literal(false),
      })
      .strict(),
    timeoutMs: z.literal(300000),
  })
  .strict();

export type EditTransportOptions = z.infer<typeof editTransportOptionsSchema>;

export const editSourceMetadataSchema = z
  .object({
    kind: z.literal("edit"),
    parentVersionId: z.string().uuid(),
    selectionId: z.string().uuid(),
    paddingPx: z.union([z.literal(16), z.literal(32)]),
    featherPx: z.literal(MASK_FEATHER_PX),
    targetLabel: z.string().min(1).max(80),
    instruction: z.string().min(1).max(2000),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.enum(EDIT_MODELS),
    referenceAssetIds: z.array(z.string().uuid()).max(2),
    referenceSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
    maskPipelineVersion: z.literal(MASK_PIPELINE_VERSION),
    promptVersion: z.literal(EDIT_PROMPT_VERSION),
    normalizationVersion: z.literal("normalization-v1"),
    pricingVersion: z.string().min(1),
    capabilityVersion: z.string().min(1),
  })
  .strict()
  .refine(
    (value) => value.referenceAssetIds.length === value.referenceSha256.length,
    "Reference IDs and hashes must have the same length.",
  );

export type EditSourceMetadata = z.infer<typeof editSourceMetadataSchema>;

export const editSnapshotSchema = z
  .object({
    operation: z.literal("edit"),
    parentVersionId: z.string().uuid(),
    sourceAssetId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceWidth: z.literal(1024),
    sourceHeight: z.literal(1024),
    selectionId: z.string().uuid(),
    selectionSourceVersionId: z.string().uuid(),
    binaryMaskAssetId: z.string().uuid(),
    binaryMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    paddingPx: z.union([z.literal(16), z.literal(32)]),
    featherPx: z.literal(MASK_FEATHER_PX),
    allowedMaskAssetId: z.string().uuid(),
    allowedMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    blendMaskAssetId: z.string().uuid(),
    blendMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    regionBoundingBox: boundsSchema,
    regionPercentages: regionPercentagesSchema,
    targetLabel: z.string().min(1).max(80),
    instruction: z.string().min(1).max(2000),
    prompt: z.string().min(1).max(4000),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    promptVersion: z.literal(EDIT_PROMPT_VERSION),
    model: z.enum(EDIT_MODELS),
    referenceAssetIds: z.array(z.string().uuid()).max(2),
    referenceSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2),
    executionMode: z.enum(["mock", "live"]),
    normalizationVersion: z.literal("normalization-v1"),
    maskPipelineVersion: z.literal(MASK_PIPELINE_VERSION),
    pricingVersion: z.string().min(1),
    capabilityVersion: z.string().min(1),
    reservationUsdMicros: z.number().int().nonnegative(),
    transportOptions: editTransportOptionsSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.referenceAssetIds.length === value.referenceSha256.length &&
      value.selectionSourceVersionId === value.parentVersionId,
    "Edit snapshot reference or parent/selection binding is inconsistent.",
  );

export type EditSnapshot = z.infer<typeof editSnapshotSchema>;

export const editMetricsSchema = z
  .object({
    protectedPixelCount: z.number().int().nonnegative(),
    rawBackgroundMae: z.number().nonnegative().nullable(),
    finalBackgroundMae: z.number().nonnegative().nullable(),
    protectedMismatchPixels: z.number().int().nonnegative(),
    nativeWidth: z.number().int().positive().optional(),
    nativeHeight: z.number().int().positive().optional(),
    normalizedWidth: z.number().int().positive().optional(),
    normalizedHeight: z.number().int().positive().optional(),
    compositePipelineVersion: z.literal(COMPOSITE_PIPELINE_VERSION),
    maskPipelineVersion: z.literal(MASK_PIPELINE_VERSION),
  })
  .strict();

export type EditMetrics = z.infer<typeof editMetricsSchema>;

export const sourceMetadataSchema = z.object({
  fixtureId: z.string().min(1),
  provenance: z.enum(["licensed_photo", "synthetic"]),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  normalizationVersion: z.literal("normalization-v1"),
  licenseRecord: z.string().nullable(),
  generator: z.string().optional(),
  generatorVersion: z.string().optional(),
});

export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

export const generationSourceMetadataSchema = z
  .object({
    kind: z.literal("generation"),
    mode: z.enum(["preset", "custom"]),
    presetId: z.enum(SCENE_PRESET_IDS).nullable(),
    presetVersion: z.literal("v1").nullable(),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.literal("openai/gpt-image-2.5-flare"),
    pricingVersion: z.string().min(1),
    capabilityVersion: z.string().min(1),
  })
  .strict();

export type GenerationSourceMetadata = z.infer<typeof generationSourceMetadataSchema>;

export const versionSourceMetadataSchema = z.union([
  sourceMetadataSchema,
  generationSourceMetadataSchema,
  editSourceMetadataSchema,
]);

export type VersionSourceMetadata = z.infer<typeof versionSourceMetadataSchema>;

export const generationTransportOptionsSchema = z
  .object({
    aspectRatio: z.literal("1:1"),
    quality: z.literal("medium"),
    background: z.literal("opaque"),
    n: z.literal(1),
    provider: z
      .object({
        only: z.tuple([z.literal("openai")]),
        allowFallbacks: z.literal(false),
      })
      .strict(),
    timeoutMs: z.literal(300000),
  })
  .strict();

export type GenerationTransportOptions = z.infer<typeof generationTransportOptionsSchema>;

export const generationSnapshotSchema = z
  .object({
    operation: z.literal("generate"),
    mode: z.enum(["preset", "custom"]),
    presetId: z.enum(SCENE_PRESET_IDS).nullable(),
    presetVersion: z.literal("v1").nullable(),
    prompt: z.string().min(1).max(2000),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.literal("openai/gpt-image-2.5-flare"),
    executionMode: z.enum(["mock", "live"]),
    transportOptions: generationTransportOptionsSchema,
    pricingVersion: z.string().min(1),
    capabilityVersion: z.string().min(1),
    reservationUsdMicros: z.number().int().nonnegative(),
  })
  .strict();

export type GenerationSnapshot = z.infer<typeof generationSnapshotSchema>;

export const evaluationSchema = z
  .object({
    boundaryArtifacts: z.number().int().min(1).max(5),
    promptAdherence: z.number().int().min(1).max(5),
    referenceFidelity: z.number().int().min(1).max(5).nullable(),
    plausibility: z.number().int().min(1).max(5),
    notes: z.string().max(1000),
  })
  .strict();

export type Evaluation = z.infer<typeof evaluationSchema>;

const responseMetadataSchema = z.record(z.string(), z.unknown());

export const providerReceiptSchema = z.union([
  z
    .object({
      kind: z.literal("image"),
      complete: z.literal(true),
      rawAssetId: z.string().uuid(),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("segment"),
      representation: z.literal("sam-records"),
      complete: z.literal(true),
      records: z.array(samMaskRecordSchema).min(1),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("segment"),
      representation: z.literal("full-mask-asset"),
      complete: z.literal(true),
      binaryMaskAssetId: z.string().uuid(),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
]);

export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export const runInputSnapshotSchema = z.record(z.string(), z.unknown());

export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

export const regionVariantSchema = z
  .object({
    paddingPx: z.union([z.literal(16), z.literal(32)]),
    allowedMaskAssetId: z.string().uuid(),
    allowedMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    blendMaskAssetId: z.string().uuid(),
    blendMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    boundingBox: boundsSchema,
    percentages: regionPercentagesSchema,
  })
  .strict();

export type RegionVariant = z.infer<typeof regionVariantSchema>;

export const regionsSchema = z
  .object({
    pipelineVersion: z.literal(MASK_PIPELINE_VERSION),
    featherPx: z.literal(MASK_FEATHER_PX),
    paddingPx: z.tuple([z.literal(16), z.literal(32)]),
    variants: z
      .object({
        "16": regionVariantSchema,
        "32": regionVariantSchema,
      })
      .strict(),
  })
  .strict();

export type Regions = z.infer<typeof regionsSchema>;

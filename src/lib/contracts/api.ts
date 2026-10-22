import { z } from "zod";

import { SCENE_PRESET_IDS } from "../../config/scene-presets";
import {
  EDIT_MODELS,
  pointSchema,
  SAM_MAX_POINTS_PER_LABEL,
  type Bounds,
  type EditMetrics,
  type EditTransportOptions,
  type Evaluation,
  type Point,
  type RegionPercentages,
  type Regions,
  type VersionSourceMetadata,
} from "./domain";

export const createProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const sampleImportSchema = z
  .object({
    sampleId: z.literal("living-room-v1"),
  })
  .strict();

export type SampleImportInput = z.infer<typeof sampleImportSchema>;

export const activeVersionSchema = z
  .object({
    versionId: z.string().uuid(),
  })
  .strict();

export type ActiveVersionInput = z.infer<typeof activeVersionSchema>;

export const assetRoleSchema = z.enum(["base", "reference"]);

export type AssetRole = z.infer<typeof assetRoleSchema>;

export const costConsentSchema = z
  .object({
    pricingVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}-v[1-9]\d*$/),
    reservationUsdMicros: z.number().int().nonnegative(),
    acknowledged: z.literal(true),
  })
  .strict();

export type CostConsent = z.infer<typeof costConsentSchema>;

export const generationInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("preset"),
      presetId: z.enum(SCENE_PRESET_IDS),
    })
    .strict(),
  z
    .object({
      mode: z.literal("custom"),
      prompt: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export type GenerationInput = z.infer<typeof generationInputSchema>;

export const generationRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    input: generationInputSchema,
    costConsent: costConsentSchema,
  })
  .strict();

export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export const segmentationRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    sourceVersionId: z.string().uuid(),
    positivePoints: z.array(pointSchema).min(1).max(SAM_MAX_POINTS_PER_LABEL),
    negativePoints: z.array(pointSchema).max(SAM_MAX_POINTS_PER_LABEL),
    costConsent: costConsentSchema,
  })
  .strict();

export type SegmentationRequest = z.infer<typeof segmentationRequestSchema>;

const editScopeFields = {
  scope: z.enum(["selection", "scene"]).default("selection"),
  selectionId: z.string().uuid().optional(),
  paddingPx: z.union([z.literal(16), z.literal(32)]).optional(),
};

function refineEditScope(
  value: { scope: "selection" | "scene"; selectionId?: string; paddingPx?: 16 | 32 },
  context: z.RefinementCtx,
): void {
  if (value.scope === "selection") {
    if (value.selectionId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectionId"],
        message: "A selection is required for a selection edit.",
      });
    }
    if (value.paddingPx === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paddingPx"],
        message: "Padding is required for a selection edit.",
      });
    }
    return;
  }
  if (value.selectionId !== undefined || value.paddingPx !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message: "A whole-scene edit does not accept a selection or padding.",
    });
  }
}

export const editRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    parentVersionId: z.string().uuid(),
    ...editScopeFields,
    targetLabel: z.string().trim().min(1).max(80).optional(),
    instruction: z.string().trim().min(1).max(2000),
    referenceAssetIds: z
      .array(z.string().uuid())
      .max(2)
      .refine((ids) => new Set(ids).size === ids.length, "Reference asset IDs must be unique."),
    model: z.enum(EDIT_MODELS),
    costConsent: costConsentSchema,
  })
  .strict()
  .superRefine(refineEditScope);

export type EditRequest = z.infer<typeof editRequestSchema>;

export const comparisonRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    parentVersionId: z.string().uuid(),
    ...editScopeFields,
    targetLabel: z.string().trim().min(1).max(80).optional(),
    instruction: z.string().trim().min(1).max(2000),
    referenceAssetIds: z
      .array(z.string().uuid())
      .max(2)
      .refine((ids) => new Set(ids).size === ids.length, "Reference asset IDs must be unique."),
    costConsent: costConsentSchema,
  })
  .strict()
  .superRefine(refineEditScope);

export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>;

export const retryRequestSchema = z
  .object({
    costConsent: costConsentSchema,
    acknowledgePossibleDuplicateCharge: z.boolean(),
  })
  .strict();

export type RetryRequest = z.infer<typeof retryRequestSchema>;

export const idempotencyKeySchema = z.string().uuid();

export type ErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_POINT"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "PROJECT_INITIALIZING"
  | "ROOT_ALREADY_EXISTS"
  | "STALE_SELECTION"
  | "PRICING_CHANGED"
  | "RETRY_EXISTS"
  | "UPLOAD_TOO_LARGE"
  | "REQUEST_TOO_LARGE"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "INVALID_IMAGE"
  | "INVALID_SELECTION"
  | "INVALID_PROVIDER_OUTPUT"
  | "INVALID_RUN_STATE"
  | "BUDGET_EXCEEDED"
  | "PROVIDER_UNAVAILABLE"
  | "FIXTURES_NOT_PREPARED"
  | "FIXTURE_LICENSE_MISSING"
  | "FIXTURE_AMBIGUOUS"
  | "CONFIG_INVALID"
  | "INTERNAL_ERROR";

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export interface ProjectDto {
  id: string;
  title: string;
  rootVersionId: string | null;
  activeVersionId: string | null;
  budgetLimitUsdMicros: number;
  createdAt: number;
}

export interface VersionDto {
  id: string;
  parentVersionId: string | null;
  imageAssetId: string;
  origin: "upload" | "sample" | "generate" | "edit";
  originalAssetId: string | null;
  originatingRunId: string | null;
  sourceMetadata: VersionSourceMetadata | null;
  createdAt: number;
}

export interface ReferenceAssetDto {
  id: string;
  width: number;
  height: number;
  sha256: string;
  createdAt: number;
}

export interface SelectionDto {
  id: string;
  sourceVersionId: string;
  positivePoints: Point[];
  negativePoints: Point[];
  binaryMaskAssetId: string;
  regions: Regions;
  createdAt: number;
}

export interface RunInputSummaryDto {
  mode: "preset" | "custom";
  presetId: string | null;
}

export interface SegmentInputSummaryDto {
  sourceVersionId: string;
  positivePoints: Point[];
  negativePoints: Point[];
}

export interface EditInputSummaryDto {
  scope: "selection" | "scene";
  parentVersionId: string;
  selectionId: string | null;
  paddingPx: 16 | 32 | null;
  targetLabel: string | null;
  instruction: string;
  referenceAssetIds: string[];
  model: string;
}

export type RetryMode = "local" | "provider" | "none";

export interface RunSummaryDto {
  id: string;
  kind: "generate" | "segment" | "edit";
  executionMode: "live" | "mock" | "fixture";
  model: string;
  status: "queued" | "running" | "succeeded" | "failed" | "needs_review";
  stage: string;
  parentVersionId: string | null;
  outputVersionId: string | null;
  outputSelectionId: string | null;
  rawAssetId: string | null;
  normalizedRawAssetId: string | null;
  comparisonGroupId: string | null;
  retryOfRunId: string | null;
  commonInputHash: string | null;
  inputSummary: RunInputSummaryDto | null;
  segmentInput: SegmentInputSummaryDto | null;
  editInput: EditInputSummaryDto | null;
  metrics: EditMetrics | null;
  evaluation: Evaluation | null;
  retryMode: RetryMode;
  retryReservationUsdMicros: number;
  possibleDuplicateCharge: boolean;
  providerLatencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  cost: {
    reservedUsdMicros: number;
    budgetChargeUsdMicros: number;
    amountUsdMicros: number | null;
    provenance: "provider" | "calculated" | "estimated" | "unavailable" | null;
    outcome: "pending" | "completed" | "rejected" | "unknown" | null;
  };
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface PublicPricingDto {
  version: string;
  currency: "USD";
  reservations: {
    projectBudgetUsdMicros: number;
    imageUsdMicros: number;
    comparisonUsdMicros: number;
    segmentationUsdMicros: number;
  };
  models: Array<{
    id: string;
    displayName: string;
    rates: Array<Record<string, unknown>>;
  }>;
}

export interface ProjectSnapshotDto {
  project: ProjectDto;
  versions: VersionDto[];
  selections: SelectionDto[];
  references: ReferenceAssetDto[];
  runs: RunSummaryDto[];
  pricing: PublicPricingDto;
}

export interface ComparisonResponse {
  comparisonGroupId: string;
  runIds: [string, string];
}

export interface ComparisonSharedSelectionCostDto {
  selectionId: string;
  runId: string;
  model: string;
  amountUsdMicros: number | null;
  provenance: "provider" | "calculated" | "estimated" | "unavailable" | null;
  outcome: "pending" | "completed" | "rejected" | "unknown" | null;
}

export interface ComparisonModelCostDto {
  model: string;
  runIds: string[];
  knownUsdMicros: number;
  unknownAmountRuns: number;
  pendingRuns: number;
}

export interface ComparisonCandidateCostDto {
  knownUsdMicros: number;
  unknownAmountRuns: number;
  pendingRuns: number;
  byModel: ComparisonModelCostDto[];
}

export interface ComparisonDetailDto {
  comparisonGroupId: string;
  runs: RunSummaryDto[];
  sharedSelectionCost: ComparisonSharedSelectionCostDto | null;
  candidateCost: ComparisonCandidateCostDto;
}

export interface CostBucketsDto {
  providerUsdMicros: number;
  calculatedUsdMicros: number;
  estimatedUsdMicros: number;
  activeReservationUsdMicros: number;
  unknownHoldUsdMicros: number;
}

export interface ProjectCostTotalsDto extends CostBucketsDto {
  commitmentUsdMicros: number;
  budgetLimitUsdMicros: number;
  remainingUsdMicros: number;
  overrunUsdMicros: number;
}

export interface CostEventDto {
  id: string;
  runId: string;
  operation: "generate" | "segment" | "edit";
  provider: string;
  model: string;
  executionMode: "live" | "mock" | "fixture";
  outcome: "pending" | "completed" | "rejected" | "unknown";
  amountUsdMicros: number | null;
  costProvenance: "provider" | "calculated" | "estimated" | "unavailable";
  pricingVersion: string;
  providerRequestId: string | null;
  elapsedMs: number | null;
  createdAt: number;
  settledAt: number | null;
}

export interface ProjectCostsDto {
  totals: ProjectCostTotalsDto;
  byOperation: Array<CostBucketsDto & { operation: "generate" | "segment" | "edit" }>;
  byModel: Array<CostBucketsDto & { model: string }>;
  events: CostEventDto[];
}

export interface EvaluationResponse {
  evaluation: Evaluation;
}

export interface GenerationResponse {
  runId: string;
}

export interface SegmentationResponse {
  runId: string;
}

export interface EditResponse {
  runId: string;
}

export interface RetryResponse {
  runId: string;
}

export type RunDetailInputDto =
  | {
      kind: "generate";
      mode: "preset" | "custom";
      presetId: string | null;
      presetVersion: string | null;
      prompt: string;
      model: string;
      pricingVersion: string;
      capabilityVersion: string;
      reservationUsdMicros: number;
    }
  | {
      kind: "segment";
      sourceVersionId: string;
      sourceAssetId: string;
      sourceSha256: string;
      width: number;
      height: number;
      positivePoints: Point[];
      negativePoints: Point[];
      prompt: string;
      promptVersion: string;
      model: string;
      parserVersion: string;
      pricingVersion: string;
      capabilityVersion: string;
      reservationUsdMicros: number;
    }
  | {
      kind: "edit";
      scope: "selection" | "scene";
      parentVersionId: string;
      sourceAssetId: string;
      sourceSha256: string;
      selectionId: string | null;
      paddingPx: 16 | 32 | null;
      featherPx: number | null;
      regionBoundingBox: Bounds | null;
      regionPercentages: RegionPercentages | null;
      targetLabel: string | null;
      instruction: string;
      prompt: string;
      promptVersion: string;
      model: string;
      referenceAssetIds: string[];
      referenceSha256: string[];
      maskPipelineVersion: string | null;
      normalizationVersion: string;
      transportOptions: EditTransportOptions;
      pricingVersion: string;
      capabilityVersion: string;
      reservationUsdMicros: number;
    };

export interface RunDetailDto {
  run: RunSummaryDto;
  input: RunDetailInputDto | null;
  usage: {
    outcome: "pending" | "completed" | "rejected" | "unknown";
    amountUsdMicros: number | null;
    costProvenance: "provider" | "calculated" | "estimated" | "unavailable";
    pricingVersion: string;
    providerRequestId: string | null;
    elapsedMs: number | null;
  } | null;
}

export interface ProjectListDto {
  projects: Array<Pick<ProjectDto, "id" | "title" | "createdAt">>;
}

export interface CreateProjectResponse {
  projectId: string;
}

export interface SampleImportResponse {
  rootVersionId: string;
  assetId: string;
}

export interface ActiveVersionResponse {
  activeVersionId: string;
}

export interface AssetUploadResponse {
  assetId: string;
  rootVersionId: string | null;
  width: number;
  height: number;
}

export interface HealthResponse {
  status: "ready" | "not_ready";
  modes: {
    ai: "mock" | "live";
    sam: "fixture" | "live";
  };
  databaseReady: boolean;
  worker: {
    status: "ready" | "missing" | "stale";
    heartbeatAgeMs: number | null;
  };
  providers: {
    images: { available: boolean; reason: string | null };
    segmentation: { available: boolean; reason: string | null };
  };
  fixtures: {
    sampleProvenance: "licensed_photo" | "synthetic" | null;
    licensedPhotosReady: boolean;
    samFixtureReady: boolean;
  };
}

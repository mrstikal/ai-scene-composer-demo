import { z } from "zod";

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
  sourceMetadata: unknown;
  createdAt: number;
}

export interface SelectionDto {
  id: string;
  sourceVersionId: string;
  positivePoints: unknown;
  negativePoints: unknown;
  binaryMaskAssetId: string;
  regions: unknown;
  createdAt: number;
}

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
  errorCode: string | null;
  errorMessage: string | null;
  cost: {
    reservedUsdMicros: number;
    budgetChargeUsdMicros: number;
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
  runs: RunSummaryDto[];
  pricing: PublicPricingDto;
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

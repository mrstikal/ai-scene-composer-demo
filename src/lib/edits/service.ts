import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { sha256Hex } from "../assets/store";
import type { AppEnv } from "../config/env";
import {
  assertCompatibleConfig,
  getPricingConfig,
  getProviderCapabilities,
} from "../config/pricing";
import type { CostConsent, EditResponse } from "../contracts/api";
import {
  EDIT_MODELS,
  EDIT_PROMPT_VERSION,
  MASK_FEATHER_PX,
  MASK_PIPELINE_VERSION,
  editSnapshotSchema,
  regionsSchema,
  type EditModel,
  type EditSnapshot,
  type RegionVariant,
} from "../contracts/domain";
import type { AppDatabase, DatabaseHandle } from "../db/client";
import {
  assets,
  runs,
  selections,
  versions,
  type AssetRow,
  type SelectionRow,
} from "../db/schema";
import { immediateTransaction } from "../db/transaction";
import { AppError } from "../errors";
import {
  findIdempotency,
  hashRequest,
  insertIdempotency,
  isUniqueConstraintError,
  replayIdempotent,
  type StoredIdempotentResponse,
} from "../idempotency/service";
import { assertReservationAllowed } from "../budget/service";
import { buildEditCommonInputHash } from "./common-input";
import { buildEditPrompt } from "./prompt";
import { getProjectOrThrow } from "../projects/service";

export type EditExecutionMode = "mock" | "live";

export function editExecutionMode(env: AppEnv): EditExecutionMode {
  return env.aiMode;
}

export function editReservationUsdMicros(env: AppEnv): number {
  return env.aiMode === "mock" ? 0 : env.imageReservationUsdMicros;
}

function requireEditModel(model: string): EditModel {
  if (!(EDIT_MODELS as readonly string[]).includes(model)) {
    throw new AppError(400, "INVALID_REQUEST", "The selected edit model is not supported.");
  }
  return model as EditModel;
}

export function normalizeEditText(input: {
  targetLabel: string | undefined;
  instruction: string;
}): { targetLabel: string; instruction: string } {
  const targetLabel = (input.targetLabel ?? "selected object").trim();
  const instruction = input.instruction.trim();
  if (targetLabel.length === 0 || targetLabel.length > 80) {
    throw new AppError(400, "INVALID_REQUEST", "Target label must contain 1-80 characters.");
  }
  if (instruction.length === 0 || instruction.length > 2000) {
    throw new AppError(400, "INVALID_REQUEST", "Instruction must contain 1-2000 characters.");
  }
  return { targetLabel, instruction };
}

function validateConsent(
  consent: CostConsent,
  pricingVersion: string,
  reservationUsdMicros: number,
): void {
  if (consent.pricingVersion !== pricingVersion) {
    throw new AppError(409, "PRICING_CHANGED", "The pricing version changed. Refresh the project and retry.");
  }
  if (consent.reservationUsdMicros !== reservationUsdMicros) {
    throw new AppError(409, "PRICING_CHANGED", "The reservation changed. Refresh the project and retry.");
  }
}

function getVersionAsset(
  db: AppDatabase,
  projectId: string,
  versionId: string,
): AssetRow {
  const version = db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)))
    .get();
  if (version === undefined) {
    throw new AppError(404, "NOT_FOUND", "Parent version was not found in this project.");
  }
  const asset = db.select().from(assets).where(eq(assets.id, version.imageAssetId)).get();
  if (asset === undefined) {
    throw new AppError(500, "CONFIG_INVALID", "Parent version image asset is missing.");
  }
  if (asset.width !== 1024 || asset.height !== 1024 || asset.mimeType !== "image/png") {
    throw new AppError(422, "INVALID_RUN_STATE", "Editing requires a 1024 x 1024 PNG parent.");
  }
  return asset;
}

function getProjectAsset(
  db: AppDatabase,
  projectId: string,
  assetId: string,
): AssetRow {
  const asset = db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId)))
    .get();
  if (asset === undefined) {
    throw new AppError(404, "NOT_FOUND", "Asset was not found in this project.");
  }
  return asset;
}

function getMaskAsset(
  db: AppDatabase,
  projectId: string,
  assetId: string,
  kind: "selection_mask" | "allowed_mask" | "blend_mask",
  expectedSha256: string | null,
): AssetRow {
  const asset = getProjectAsset(db, projectId, assetId);
  if (asset.kind !== kind) {
    throw new AppError(422, "INVALID_SELECTION", "Selection mask asset has the wrong kind.");
  }
  if (expectedSha256 !== null && asset.sha256 !== expectedSha256) {
    throw new AppError(422, "INVALID_SELECTION", "Selection mask assets do not match the saved selection.");
  }
  return asset;
}

function getReferenceAssets(
  db: AppDatabase,
  projectId: string,
  assetIds: readonly string[],
): AssetRow[] {
  if (assetIds.length > 2) {
    throw new AppError(400, "INVALID_REQUEST", "Edits support at most two references.");
  }
  if (new Set(assetIds).size !== assetIds.length) {
    throw new AppError(400, "INVALID_REQUEST", "Reference asset IDs must be unique.");
  }
  return assetIds.map((assetId) => {
    const asset = getProjectAsset(db, projectId, assetId);
    if (asset.kind !== "reference") {
      throw new AppError(400, "INVALID_REQUEST", "Only reference assets can be used as edit references.");
    }
    return asset;
  });
}

export function assertEditInputsAvailable(
  db: AppDatabase,
  projectId: string,
  snapshot: EditSnapshot,
): void {
  getVersionAsset(db, projectId, snapshot.parentVersionId);
  const selection = db
    .select()
    .from(selections)
    .where(and(eq(selections.id, snapshot.selectionId), eq(selections.projectId, projectId)))
    .get();
  if (selection === undefined) {
    throw new AppError(404, "NOT_FOUND", "Selection was not found in this project.");
  }
  if (selection.sourceVersionId !== snapshot.parentVersionId) {
    throw new AppError(409, "STALE_SELECTION", "The selection belongs to a different source version.");
  }
  getMaskAsset(db, projectId, snapshot.binaryMaskAssetId, "selection_mask", snapshot.binaryMaskSha256);
  getMaskAsset(db, projectId, snapshot.allowedMaskAssetId, "allowed_mask", snapshot.allowedMaskSha256);
  getMaskAsset(db, projectId, snapshot.blendMaskAssetId, "blend_mask", snapshot.blendMaskSha256);
  const references = getReferenceAssets(db, projectId, snapshot.referenceAssetIds);
  references.forEach((asset, index) => {
    if (asset.sha256 !== snapshot.referenceSha256[index]) {
      throw new AppError(422, "INVALID_RUN_STATE", "An edit reference changed after the snapshot.");
    }
  });
}

export function buildEditSnapshotForModel(input: {
  db: AppDatabase;
  env: AppEnv;
  projectId: string;
  parentVersionId: string;
  parentAsset: AssetRow;
  selection: SelectionRow;
  variant: RegionVariant;
  paddingPx: 16 | 32;
  targetLabel: string;
  instruction: string;
  referenceAssets: AssetRow[];
  model: EditModel;
  reservationUsdMicros: number;
  pricingVersion: string;
  capabilityVersion: string;
}): { snapshot: EditSnapshot; commonInputHash: string } {
  const binaryMask = getMaskAsset(
    input.db,
    input.projectId,
    input.selection.binaryMaskAssetId,
    "selection_mask",
    null,
  );
  getMaskAsset(
    input.db,
    input.projectId,
    input.variant.allowedMaskAssetId,
    "allowed_mask",
    input.variant.allowedMaskSha256,
  );
  getMaskAsset(
    input.db,
    input.projectId,
    input.variant.blendMaskAssetId,
    "blend_mask",
    input.variant.blendMaskSha256,
  );

  const prompt = buildEditPrompt({
    targetLabel: input.targetLabel,
    instruction: input.instruction,
    percentages: input.variant.percentages,
    referenceCount: input.referenceAssets.length,
  });

  const snapshot = editSnapshotSchema.parse({
    operation: "edit",
    parentVersionId: input.parentVersionId,
    sourceAssetId: input.parentAsset.id,
    sourceSha256: input.parentAsset.sha256,
    sourceWidth: input.parentAsset.width,
    sourceHeight: input.parentAsset.height,
    selectionId: input.selection.id,
    selectionSourceVersionId: input.selection.sourceVersionId,
    binaryMaskAssetId: binaryMask.id,
    binaryMaskSha256: binaryMask.sha256,
    paddingPx: input.paddingPx,
    featherPx: MASK_FEATHER_PX,
    allowedMaskAssetId: input.variant.allowedMaskAssetId,
    allowedMaskSha256: input.variant.allowedMaskSha256,
    blendMaskAssetId: input.variant.blendMaskAssetId,
    blendMaskSha256: input.variant.blendMaskSha256,
    regionBoundingBox: input.variant.boundingBox,
    regionPercentages: input.variant.percentages,
    targetLabel: input.targetLabel,
    instruction: input.instruction,
    prompt,
    promptSha256: sha256Hex(Buffer.from(prompt, "utf8")),
    promptVersion: EDIT_PROMPT_VERSION,
    model: input.model,
    referenceAssetIds: input.referenceAssets.map((asset) => asset.id),
    referenceSha256: input.referenceAssets.map((asset) => asset.sha256),
    executionMode: editExecutionMode(input.env),
    normalizationVersion: "normalization-v1",
    maskPipelineVersion: MASK_PIPELINE_VERSION,
    pricingVersion: input.pricingVersion,
    capabilityVersion: input.capabilityVersion,
    reservationUsdMicros: input.reservationUsdMicros,
    transportOptions: {
      aspectRatio: "1:1",
      quality: "medium",
      background: "opaque",
      n: 1,
      provider: { only: ["openai"], allowFallbacks: false },
      timeoutMs: 300000,
    },
  });

  return { snapshot, commonInputHash: buildEditCommonInputHash(snapshot) };
}

export function prepareEditSnapshot(input: {
  db: AppDatabase;
  env: AppEnv;
  projectId: string;
  parentVersionId: string;
  selectionId: string;
  paddingPx: 16 | 32;
  targetLabel: string;
  instruction: string;
  referenceAssetIds: readonly string[];
  model: EditModel;
  reservationUsdMicros: number;
  pricingVersion: string;
  capabilityVersion: string;
}): { snapshot: EditSnapshot; commonInputHash: string; selection: SelectionRow } {
  const parentAsset = getVersionAsset(input.db, input.projectId, input.parentVersionId);
  const selection = input.db
    .select()
    .from(selections)
    .where(and(eq(selections.id, input.selectionId), eq(selections.projectId, input.projectId)))
    .get();
  if (selection === undefined) {
    throw new AppError(404, "NOT_FOUND", "Selection was not found in this project.");
  }
  if (selection.sourceVersionId !== input.parentVersionId) {
    throw new AppError(409, "STALE_SELECTION", "The selection belongs to a different source version.");
  }

  const regions = regionsSchema.safeParse(selection.regionsJson);
  if (!regions.success) {
    throw new AppError(422, "INVALID_SELECTION", "The saved selection regions are invalid.");
  }
  const variant = regions.data.variants[String(input.paddingPx) as "16" | "32"];
  if (variant === undefined || variant.paddingPx !== input.paddingPx) {
    throw new AppError(422, "INVALID_SELECTION", "The selected padding variant is missing.");
  }

  const referenceAssets = getReferenceAssets(input.db, input.projectId, input.referenceAssetIds);
  const built = buildEditSnapshotForModel({
    db: input.db,
    env: input.env,
    projectId: input.projectId,
    parentVersionId: input.parentVersionId,
    parentAsset,
    selection,
    variant,
    paddingPx: input.paddingPx,
    targetLabel: input.targetLabel,
    instruction: input.instruction,
    referenceAssets,
    model: input.model,
    reservationUsdMicros: input.reservationUsdMicros,
    pricingVersion: input.pricingVersion,
    capabilityVersion: input.capabilityVersion,
  });

  return { ...built, selection };
}

export async function enqueueEdit(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  parentVersionId: string;
  selectionId: string;
  paddingPx: 16 | 32;
  targetLabel: string | undefined;
  instruction: string;
  referenceAssetIds: string[];
  model: string;
  costConsent: CostConsent;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, idempotencyKey } = input;
  const { db, sqlite } = handle;
  assertCompatibleConfig();
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();
  const executionMode = editExecutionMode(env);
  const reservationUsdMicros = editReservationUsdMicros(env);
  const model = requireEditModel(input.model);
  if (pricing.providers.openrouter.models[model] === undefined) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "The selected edit model is not configured.");
  }

  const requestHash = hashRequest({
    operation: "edit",
    projectId,
    parentVersionId: input.parentVersionId,
    selectionId: input.selectionId,
    paddingPx: input.paddingPx,
    targetLabel: input.targetLabel ?? null,
    instruction: input.instruction,
    referenceAssetIds: input.referenceAssetIds,
    model,
    costConsent: input.costConsent,
    executionMode,
    pricingVersion: pricing.version,
    capabilityVersion: capabilities.version,
    reservationUsdMicros,
  });
  const replay = replayIdempotent(findIdempotency(db, projectId, idempotencyKey), "edit", requestHash);
  if (replay !== null) return replay;

  validateConsent(input.costConsent, pricing.version, reservationUsdMicros);
  const text = normalizeEditText({ targetLabel: input.targetLabel, instruction: input.instruction });
  if (executionMode === "live" && env.openRouterApiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
  }

  const runId = randomUUID();
  const response: StoredIdempotentResponse = {
    status: 202,
    body: { runId } satisfies EditResponse,
  };
  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        "edit",
        requestHash,
      );
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      getProjectOrThrow(db, projectId);
      const built = prepareEditSnapshot({
        db,
        env,
        projectId,
        parentVersionId: input.parentVersionId,
        selectionId: input.selectionId,
        paddingPx: input.paddingPx,
        targetLabel: text.targetLabel,
        instruction: text.instruction,
        referenceAssetIds: input.referenceAssetIds,
        model,
        reservationUsdMicros,
        pricingVersion: pricing.version,
        capabilityVersion: capabilities.version,
      });

      assertReservationAllowed(db, projectId, reservationUsdMicros);

      db.insert(runs)
        .values({
          id: runId,
          projectId,
          kind: "edit",
          executionMode,
          comparisonGroupId: null,
          retryOfRunId: null,
          parentVersionId: input.parentVersionId,
          inputSelectionId: built.selection.id,
          model,
          inputSnapshotJson: built.snapshot,
          commonInputHash: built.commonInputHash,
          status: "queued",
          stage: "queued",
          reservedUsdMicros: reservationUsdMicros,
          budgetChargeUsdMicros: reservationUsdMicros,
          createdAt: Date.now(),
        })
        .run();

      insertIdempotency(db, {
        projectId,
        key: idempotencyKey,
        operation: "edit",
        requestHash,
        response,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        "edit",
        requestHash,
      );
      if (afterConstraint !== null) return afterConstraint;
    }
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

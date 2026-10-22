import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { readAssetBytes, sha256Hex } from "../../assets/store";
import {
  editMetricsSchema,
  editSnapshotSchema,
  editSourceMetadataSchema,
  type EditMetrics,
  type EditSnapshot,
  type EditSourceMetadata,
} from "../../contracts/domain";
import type { AppDatabase } from "../../db/client";
import { assets, projects, runs, versions, type RunRow } from "../../db/schema";
import { immediateTransaction } from "../../db/transaction";
import { AppError } from "../../errors";
import { isUniqueConstraintError } from "../../idempotency/service";
import { compositeEdit } from "../../images/composite";
import { decodeAlphaPng, decodeMaskPng } from "../../images/mask-pipeline";
import { normalizeProviderImage } from "../../images/normalize";
import { getProjectCommitmentMicros } from "../../budget/service";
import { markRunFailed } from "../queue";
import { parseProviderReceipt } from "../receipt";
import type { RunHandler, RunHandlerContext } from "../worker";
import { createPendingUsageEvent, markUsageUnknown } from "../../usage/service";
import { markRunNeedsReview } from "../settlement";
import { createEditAdapter } from "../../providers/factory";
import type { ImageEditAdapter, ImageGenerationResult } from "../../providers/types";
import {
  insertImageAsset,
  saveImageAsset,
  saveImageReceipt,
  saveInvalidResultRawAsset,
  writeImageAsset,
} from "../image-assets";
import { settleImageResult } from "../image-settlement";

export interface EditHandlerOptions {
  adapterFactory?: (run: RunRow, context: RunHandlerContext) => ImageEditAdapter;
}

function parseSnapshot(run: RunRow): EditSnapshot {
  const parsed = editSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) {
    throw new AppError(422, "INVALID_RUN_STATE", "Edit input snapshot is invalid.");
  }
  return parsed.data;
}

function editMetadata(snapshot: EditSnapshot): EditSourceMetadata {
  return editSourceMetadataSchema.parse({
    kind: "edit",
    parentVersionId: snapshot.parentVersionId,
    selectionId: snapshot.selectionId,
    paddingPx: snapshot.paddingPx,
    featherPx: snapshot.featherPx,
    targetLabel: snapshot.targetLabel,
    instruction: snapshot.instruction,
    promptSha256: snapshot.promptSha256,
    model: snapshot.model,
    referenceAssetIds: snapshot.referenceAssetIds,
    referenceSha256: snapshot.referenceSha256,
    maskPipelineVersion: snapshot.maskPipelineVersion,
    promptVersion: snapshot.promptVersion,
    normalizationVersion: snapshot.normalizationVersion,
    pricingVersion: snapshot.pricingVersion,
    capabilityVersion: snapshot.capabilityVersion,
  });
}

function markEditFailed(
  context: RunHandlerContext,
  run: RunRow,
  code: string,
  message: string,
  metrics: EditMetrics | null = null,
): void {
  const current = context.db.select().from(runs).where(eq(runs.id, run.id)).get() ?? run;
  if (metrics !== null) {
    context.db
      .update(runs)
      .set({ metricsJson: metrics })
      .where(eq(runs.id, run.id))
      .run();
  }
  markRunFailed(context.db, current, { code, message, preProvider: false });
}

async function loadSourceBytes(
  context: RunHandlerContext,
  snapshot: EditSnapshot,
): Promise<Buffer> {
  const sourceAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, snapshot.sourceAssetId))
    .get();
  if (
    sourceAsset === undefined ||
    sourceAsset.width !== snapshot.sourceWidth ||
    sourceAsset.height !== snapshot.sourceHeight ||
    sourceAsset.mimeType !== "image/png" ||
    (sourceAsset.kind !== "canonical" && sourceAsset.kind !== "final")
  ) {
    throw new AppError(422, "INVALID_RUN_STATE", "The edit source asset is missing or changed.");
  }
  const sourceBytes = await readAssetBytes(context.env.assetDir, sourceAsset.relativePath);
  if (sha256Hex(sourceBytes) !== snapshot.sourceSha256) {
    throw new AppError(422, "INVALID_RUN_STATE", "The edit source hash changed after enqueue.");
  }
  return sourceBytes;
}

function findMaskAssets(context: RunHandlerContext, snapshot: EditSnapshot) {
  const binaryAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, snapshot.binaryMaskAssetId))
    .get();
  const allowedAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, snapshot.allowedMaskAssetId))
    .get();
  const blendAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, snapshot.blendMaskAssetId))
    .get();
  if (
    binaryAsset === undefined ||
    allowedAsset === undefined ||
    blendAsset === undefined ||
    binaryAsset.kind !== "selection_mask" ||
    allowedAsset.kind !== "allowed_mask" ||
    blendAsset.kind !== "blend_mask" ||
    binaryAsset.sha256 !== snapshot.binaryMaskSha256 ||
    allowedAsset.sha256 !== snapshot.allowedMaskSha256 ||
    blendAsset.sha256 !== snapshot.blendMaskSha256
  ) {
    throw new AppError(422, "INVALID_SELECTION", "The edit region assets are missing or changed.");
  }
  return { binaryAsset, allowedAsset, blendAsset };
}

async function loadSourceAndMasks(
  context: RunHandlerContext,
  snapshot: EditSnapshot,
): Promise<{
  sourceBytes: Buffer;
  allowedMask: Uint8Array;
  blendMask: Uint8Array;
}> {
  const sourceBytes = await loadSourceBytes(context, snapshot);
  const { allowedAsset, blendAsset } = findMaskAssets(context, snapshot);

  const allowed = await decodeMaskPng(
    await readAssetBytes(context.env.assetDir, allowedAsset.relativePath),
  );
  const blend = await decodeAlphaPng(
    await readAssetBytes(context.env.assetDir, blendAsset.relativePath),
  );
  if (
    allowed.width !== 1024 ||
    allowed.height !== 1024 ||
    blend.width !== 1024 ||
    blend.height !== 1024
  ) {
    throw new AppError(422, "INVALID_SELECTION", "The edit region assets have wrong dimensions.");
  }

  return { sourceBytes, allowedMask: allowed.mask, blendMask: blend.alpha };
}

async function loadReferenceImages(
  context: RunHandlerContext,
  snapshot: EditSnapshot,
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (let index = 0; index < snapshot.referenceAssetIds.length; index += 1) {
    const assetId = snapshot.referenceAssetIds[index];
    const expectedHash = snapshot.referenceSha256[index];
    if (assetId === undefined || expectedHash === undefined) {
      throw new AppError(422, "INVALID_RUN_STATE", "Edit reference list is inconsistent.");
    }
    const asset = context.db.select().from(assets).where(eq(assets.id, assetId)).get();
    if (asset === undefined || asset.kind !== "reference" || asset.sha256 !== expectedHash) {
      throw new AppError(422, "INVALID_RUN_STATE", "An edit reference asset is missing or changed.");
    }
    images.push(await readAssetBytes(context.env.assetDir, asset.relativePath));
  }
  return images;
}

function findVersionByRun(db: AppDatabase, runId: string) {
  return db.select().from(versions).where(eq(versions.originatingRunId, runId)).get();
}

async function persistFinalAndChild(input: {
  context: RunHandlerContext;
  run: RunRow;
  snapshot: EditSnapshot;
  rawAssetId: string;
  normalizedAssetId: string;
  sourceBytes: Buffer;
  generatedBytes: Buffer;
  allowedMask: Uint8Array;
  blendMask: Uint8Array;
  nativeWidth: number | null;
  nativeHeight: number | null;
}): Promise<void> {
  const { context, run, snapshot } = input;
  const existing = findVersionByRun(context.db, run.id);
  if (existing !== undefined) {
    context.db
      .update(runs)
      .set({
        status: "succeeded",
        stage: "done",
        finishedAt: Date.now(),
        outputVersionId: existing.id,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(runs.id, run.id))
      .run();
    return;
  }

  const composite = await compositeEdit({
    sourceBytes: input.sourceBytes,
    generatedBytes: input.generatedBytes,
    allowedMask: input.allowedMask,
    blendMask: input.blendMask,
  });
  const metrics = editMetricsSchema.parse({
    protectedPixelCount: composite.protectedPixelCount,
    rawBackgroundMae: composite.rawBackgroundMae,
    finalBackgroundMae: composite.finalBackgroundMae,
    protectedMismatchPixels: composite.protectedMismatchPixels,
    ...(input.nativeWidth === null ? {} : { nativeWidth: input.nativeWidth }),
    ...(input.nativeHeight === null ? {} : { nativeHeight: input.nativeHeight }),
    normalizedWidth: composite.width,
    normalizedHeight: composite.height,
    compositePipelineVersion: composite.compositePipelineVersion,
    maskPipelineVersion: composite.maskPipelineVersion,
  });

  if (
    composite.protectedPixelCount > 0 &&
    (composite.protectedMismatchPixels !== 0 || composite.finalBackgroundMae !== 0)
  ) {
    markEditFailed(
      context,
      run,
      "PROTECTED_PIXELS_CHANGED",
      "Protected pixels changed during compositing.",
      metrics,
    );
    return;
  }

  const finalAsset = await writeImageAsset({
    context,
    run,
    bytes: composite.bytes,
    mimeType: "image/png",
    width: composite.width,
    height: composite.height,
  });
  const versionId = randomUUID();
  const now = Date.now();

  try {
    immediateTransaction(context.sqlite, () => {
      const concurrent = findVersionByRun(context.db, run.id);
      if (concurrent !== undefined) {
        context.db
          .update(runs)
          .set({
            status: "succeeded",
            stage: "done",
            finishedAt: Date.now(),
            outputVersionId: concurrent.id,
            errorCode: null,
            errorMessage: null,
          })
          .where(eq(runs.id, run.id))
          .run();
        return;
      }

      insertImageAsset(context, run, finalAsset, "final");
      context.db
        .insert(versions)
        .values({
          id: versionId,
          projectId: run.projectId,
          parentVersionId: snapshot.parentVersionId,
          imageAssetId: finalAsset.id,
          origin: "edit",
          originalAssetId: input.rawAssetId,
          sourceMetadataJson: editMetadata(snapshot),
          originatingRunId: run.id,
          createdAt: now,
        })
        .run();

      context.db
        .update(runs)
        .set({
          status: "succeeded",
          stage: "done",
          finishedAt: now,
          rawAssetId: input.rawAssetId,
          normalizedRawAssetId: input.normalizedAssetId,
          outputVersionId: versionId,
          metricsJson: metrics,
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(runs.id, run.id))
        .run();
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = findVersionByRun(context.db, run.id);
      if (afterConstraint !== undefined) {
        context.db
          .update(runs)
          .set({
            status: "succeeded",
            stage: "done",
            finishedAt: Date.now(),
            outputVersionId: afterConstraint.id,
            errorCode: null,
            errorMessage: null,
          })
          .where(eq(runs.id, run.id))
          .run();
        return;
      }
    }
    throw error;
  }
}

async function normalizeReceiptImage(rawBytes: Buffer) {
  try {
    return await normalizeProviderImage(rawBytes);
  } catch {
    throw new AppError(
      422,
      "INVALID_PROVIDER_OUTPUT",
      "The saved raw provider image is unusable.",
    );
  }
}

async function processReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: EditSnapshot,
  receipt: Extract<ReturnType<typeof parseProviderReceipt>, { kind: "image" }>,
): Promise<void> {
  const rawAsset = context.db.select().from(assets).where(eq(assets.id, receipt.rawAssetId)).get();
  if (rawAsset === undefined || rawAsset.kind !== "raw") {
    throw new AppError(422, "INVALID_PROVIDER_OUTPUT", "The saved raw provider asset is missing.");
  }

  let rawBytes: Buffer;
  try {
    rawBytes = await readAssetBytes(context.env.assetDir, rawAsset.relativePath);
  } catch {
    throw new AppError(422, "INVALID_PROVIDER_OUTPUT", "The saved raw provider asset file is missing.");
  }

  let normalizedAsset: { id: string; bytes: Buffer };
  if (run.normalizedRawAssetId !== null) {
    const normalizedRow = context.db
      .select()
      .from(assets)
      .where(eq(assets.id, run.normalizedRawAssetId))
      .get();
    if (normalizedRow === undefined) {
      throw new AppError(422, "INVALID_PROVIDER_OUTPUT", "The saved normalized provider asset is missing.");
    }
    try {
      normalizedAsset = {
        id: normalizedRow.id,
        bytes: await readAssetBytes(context.env.assetDir, normalizedRow.relativePath),
      };
    } catch {
      const normalized = await normalizeReceiptImage(rawBytes);
      const saved = await saveImageAsset({
        context,
        run,
        kind: "canonical",
        bytes: normalized.bytes,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
      });
      context.db
        .update(runs)
        .set({ normalizedRawAssetId: saved.id, stage: "processing" })
        .where(eq(runs.id, run.id))
        .run();
      normalizedAsset = { id: saved.id, bytes: normalized.bytes };
    }
  } else {
    const normalized = await normalizeReceiptImage(rawBytes);
    const saved = await saveImageAsset({
      context,
      run,
      kind: "canonical",
      bytes: normalized.bytes,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
    context.db
      .update(runs)
      .set({ normalizedRawAssetId: saved.id, stage: "processing" })
      .where(eq(runs.id, run.id))
      .run();
    normalizedAsset = { id: saved.id, bytes: normalized.bytes };
  }

  const regions = await loadSourceAndMasks(context, snapshot);
  const metadata = receipt.responseMetadata;
  const nativeWidth =
    typeof metadata.nativeWidth === "number" ? metadata.nativeWidth : rawAsset.width > 0 ? rawAsset.width : null;
  const nativeHeight =
    typeof metadata.nativeHeight === "number" ? metadata.nativeHeight : rawAsset.height > 0 ? rawAsset.height : null;

  await persistFinalAndChild({
    context,
    run,
    snapshot,
    rawAssetId: receipt.rawAssetId,
    normalizedAssetId: normalizedAsset.id,
    sourceBytes: regions.sourceBytes,
    generatedBytes: normalizedAsset.bytes,
    allowedMask: regions.allowedMask,
    blendMask: regions.blendMask,
    nativeWidth,
    nativeHeight,
  });
}

async function persistInvalid(
  context: RunHandlerContext,
  run: RunRow,
  result: Extract<ImageGenerationResult, { kind: "invalid" }>,
): Promise<void> {
  await saveInvalidResultRawAsset(context, run, result);
  markEditFailed(context, run, "INVALID_PROVIDER_OUTPUT", result.message);
}

async function resumeFromReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: EditSnapshot,
): Promise<void> {
  const receipt = parseProviderReceipt(run.providerReceiptJson);
  if (receipt === null || receipt.kind !== "image") {
    markEditFailed(context, run, "INVALID_PROVIDER_OUTPUT", "The saved edit receipt is unusable.");
    return;
  }

  try {
    await processReceipt(context, run, snapshot, receipt);
  } catch (error) {
    if (error instanceof AppError && error.code === "INVALID_PROVIDER_OUTPUT") {
      markEditFailed(context, run, "INVALID_PROVIDER_OUTPUT", error.message);
      return;
    }
    markEditFailed(context, run, "LOCAL_PROCESSING_FAILED", "Local edit processing failed.");
  }
}

export function createEditHandler(options: EditHandlerOptions = {}): RunHandler {
  return async (run, context) => {
    let snapshot: EditSnapshot;
    try {
      snapshot = parseSnapshot(run);
    } catch {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Edit input snapshot is invalid.",
        preProvider: true,
      });
      return;
    }

    if (run.providerReceiptJson !== null) {
      await resumeFromReceipt(context, run, snapshot);
      return;
    }

    if (run.providerStartedAt !== null) {
      markUsageUnknown(context.db, run.id);
      markRunNeedsReview(context.db, run.id, { message: "The edit was dispatched but has no usable receipt." });
      return;
    }

    if (run.executionMode === "fixture") {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Fixture mode is not valid for edits.",
        preProvider: true,
      });
      return;
    }

    if (run.executionMode === "live" && context.env.openRouterApiKey === null) {
      markRunFailed(context.db, run, {
        code: "PROVIDER_UNAVAILABLE",
        message: "OpenRouter is not configured.",
        preProvider: true,
      });
      return;
    }

    let sourceBytes: Buffer;
    let referenceBytes: Buffer[];
    try {
      sourceBytes = await loadSourceBytes(context, snapshot);
      findMaskAssets(context, snapshot);
      referenceBytes = await loadReferenceImages(context, snapshot);
    } catch {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Edit inputs are missing or no longer match the snapshot.",
        preProvider: true,
      });
      return;
    }

    const adapter =
      options.adapterFactory?.(run, context) ??
      createEditAdapter(context.env, run.executionMode);

    const dispatched = immediateTransaction(context.sqlite, () => {
      const current = context.db.select().from(runs).where(eq(runs.id, run.id)).get();
      if (
        current === undefined ||
        current.status !== "running" ||
        current.providerStartedAt !== null ||
        current.providerReceiptJson !== null
      ) {
        return false;
      }

      if (run.executionMode === "live") {
        const project = context.db
          .select()
          .from(projects)
          .where(eq(projects.id, run.projectId))
          .get();
        if (
          project !== undefined &&
          getProjectCommitmentMicros(context.db, run.projectId) > project.budgetLimitUsdMicros
        ) {
          markRunFailed(context.db, run, {
            code: "BUDGET_EXCEEDED",
            message: "The project budget has been exceeded.",
            preProvider: true,
          });

          const siblings = context.db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.projectId, run.projectId),
                eq(runs.status, "queued"),
                eq(runs.executionMode, "live"),
                isNull(runs.providerStartedAt),
                isNull(runs.providerReceiptJson),
              ),
            )
            .all();
          for (const sibling of siblings) {
            if (sibling.id === run.id) continue;
            markRunFailed(context.db, sibling, {
              code: "BUDGET_EXCEEDED",
              message: "The project budget has been exceeded.",
              preProvider: true,
            });
          }
          return false;
        }
      }

      context.db
        .update(runs)
        .set({
          providerStartedAt: Date.now(),
          stage: "calling_provider",
        })
        .where(eq(runs.id, run.id))
        .run();

      createPendingUsageEvent(context.db, {
        projectId: run.projectId,
        runId: run.id,
        operation: "edit",
        provider: run.executionMode === "mock" ? "mock" : "openrouter",
        model: snapshot.model,
        executionMode: run.executionMode,
        pricingVersion: snapshot.pricingVersion,
        pricingSourceSnapshot: {
          kind: run.executionMode,
          pricingVersion: snapshot.pricingVersion,
          capabilityVersion: snapshot.capabilityVersion,
          reservationUsdMicros: snapshot.reservationUsdMicros,
        },
      });
      return true;
    });

    if (!dispatched) return;

    let result: ImageGenerationResult;
    try {
      result = await adapter.edit({
        model: snapshot.model,
        prompt: snapshot.prompt,
        orderedInputImages: [sourceBytes, ...referenceBytes],
      });
    } catch {
      markUsageUnknown(context.db, run.id);
      markRunNeedsReview(context.db, run.id, { message: "The provider outcome is unknown." });
      return;
    }

    settleImageResult(context, run, snapshot.reservationUsdMicros, result);

    if (result.kind === "ambiguous") {
      markRunNeedsReview(context.db, run.id, { message: result.message });
      return;
    }

    if (result.kind === "rejected") {
      markEditFailed(context, run, "PROVIDER_REJECTED", result.message);
      return;
    }

    if (result.kind === "invalid") {
      await persistInvalid(context, run, result);
      return;
    }

    try {
      const rawAsset = await saveImageAsset({
        context,
        run,
        kind: "raw",
        bytes: result.bytes,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
      const receipt = saveImageReceipt(context, run, rawAsset.id, result);
      await processReceipt(context, run, snapshot, receipt);
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_PROVIDER_OUTPUT") {
        markEditFailed(context, run, "INVALID_PROVIDER_OUTPUT", error.message);
        return;
      }
      markEditFailed(context, run, "LOCAL_PROCESSING_FAILED", "Local edit processing failed.");
    }
  };
}

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { readAssetBytes, sha256Hex, writeAssetBytes } from "../../assets/store";
import { getSegmentationCalculatedCostUsdMicros } from "../../config/pricing";
import {
  MASK_FEATHER_PX,
  MASK_PADDING_OPTIONS,
  MASK_PIPELINE_VERSION,
  regionsSchema,
  segmentSnapshotSchema,
  type RegionVariant,
  type SegmentSnapshot,
} from "../../contracts/domain";
import type { AppDatabase } from "../../db/client";
import { assets, projects, runs, selections, type RunRow } from "../../db/schema";
import { immediateTransaction } from "../../db/transaction";
import { AppError } from "../../errors";
import { isUniqueConstraintError } from "../../idempotency/service";
import {
  buildFullFrameMaskFromRecords,
  buildRegionMaskVariant,
  decodeMaskPng,
  encodeAlphaPng,
  encodeMaskPng,
  validateFullFrameMask,
  type FullFrameMask,
} from "../../images/mask-pipeline";
import { getProjectCommitmentMicros } from "../../budget/service";
import { markRunFailed } from "../queue";
import { parseProviderReceipt } from "../receipt";
import type { RunHandler, RunHandlerContext } from "../worker";
import { createPendingUsageEvent, markUsageUnknown, settleUsageEvent } from "../../usage/service";
import { createSegmentationAdapter } from "../../providers/factory";
import type {
  SegmentationAdapter,
  SegmentationAdapterResult,
} from "../../providers/types";
import { loadSamCapture, replaySamCapture } from "../../sam/capture";

export interface SegmentHandlerOptions {
  adapterFactory?: (run: RunRow, context: RunHandlerContext) => SegmentationAdapter;
}

interface SavedMaskAsset {
  id: string;
  kind: "selection_mask" | "allowed_mask" | "blend_mask";
  relativePath: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
}

function parseSnapshot(run: RunRow): SegmentSnapshot {
  const parsed = segmentSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) {
    throw new AppError(422, "INVALID_RUN_STATE", "Segmentation input snapshot is invalid.");
  }
  return parsed.data;
}

function findSelectionByRun(db: AppDatabase, runId: string) {
  return db.select().from(selections).where(eq(selections.originatingRunId, runId)).get();
}

function markSegmentSucceeded(db: AppDatabase, run: RunRow, selectionId: string): void {
  db.update(runs)
    .set({
      status: "succeeded",
      stage: "done",
      finishedAt: Date.now(),
      outputSelectionId: selectionId,
      errorCode: null,
      errorMessage: null,
    })
    .where(eq(runs.id, run.id))
    .run();
}

function markSegmentFailed(
  context: RunHandlerContext,
  run: RunRow,
  code: string,
  message: string,
): void {
  const current = context.db.select().from(runs).where(eq(runs.id, run.id)).get() ?? run;
  markRunFailed(context.db, current, { code, message, preProvider: false });
}

function markNeedsReview(
  db: AppDatabase,
  run: RunRow,
  message: string,
  code: "INTERRUPTED" | "PROVIDER_TIMEOUT" = "INTERRUPTED",
): void {
  db.update(runs)
    .set({
      status: "needs_review",
      stage: "error",
      finishedAt: Date.now(),
      errorCode: code,
      errorMessage: message,
    })
    .where(eq(runs.id, run.id))
    .run();
}

function updateRunAfterSettlement(
  context: RunHandlerContext,
  runId: string,
  amountUsdMicros: number | null,
): void {
  context.db
    .update(runs)
    .set({
      providerFinishedAt: Date.now(),
      ...(amountUsdMicros === null ? {} : { budgetChargeUsdMicros: amountUsdMicros }),
    })
    .where(eq(runs.id, runId))
    .run();
}

function settleResult(
  context: RunHandlerContext,
  run: RunRow,
  result: SegmentationAdapterResult,
  calculatedCostUsdMicros: number,
): number | null {
  if (result.kind === "ambiguous") {
    markUsageUnknown(context.db, run.id);
    return null;
  }

  const live = run.executionMode === "live";
  const observed = result.observedCostUsdMicros;

  if (result.kind === "rejected") {
    const amount = live ? observed : 0;
    const provenance = live ? (observed === null ? "unavailable" : "provider") : "calculated";
    settleUsageEvent(context.db, {
      runId: run.id,
      outcome: "rejected",
      amountUsdMicros: amount,
      costProvenance: provenance,
      usageJson: result.usage,
      providerRequestId: result.providerRequestId,
      elapsedMs: result.latencyMs,
    });
    updateRunAfterSettlement(context, run.id, amount);
    return amount;
  }

  const amount = live ? observed ?? calculatedCostUsdMicros : 0;
  const provenance = live ? (observed === null ? "calculated" : "provider") : "calculated";
  settleUsageEvent(context.db, {
    runId: run.id,
    outcome: "completed",
    amountUsdMicros: amount,
    costProvenance: provenance,
    usageJson: result.usage,
    providerRequestId: result.providerRequestId,
    elapsedMs: result.latencyMs,
  });
  updateRunAfterSettlement(context, run.id, amount);
  return amount;
}

async function readSourceImage(
  context: RunHandlerContext,
  snapshot: SegmentSnapshot,
): Promise<Buffer> {
  const sourceAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, snapshot.sourceAssetId))
    .get();
  if (
    sourceAsset === undefined ||
    sourceAsset.width !== snapshot.width ||
    sourceAsset.height !== snapshot.height
  ) {
    throw new AppError(422, "INVALID_RUN_STATE", "The source image asset is missing or changed.");
  }

  const bytes = await readAssetBytes(context.env.assetDir, sourceAsset.relativePath);
  if (sha256Hex(bytes) !== snapshot.sourceSha256) {
    throw new AppError(422, "INVALID_RUN_STATE", "The source image hash changed after enqueue.");
  }
  return bytes;
}

async function writeMaskAsset(input: {
  context: RunHandlerContext;
  run: RunRow;
  kind: SavedMaskAsset["kind"];
  bytes: Buffer;
  width: number;
  height: number;
}): Promise<SavedMaskAsset> {
  const assetId = randomUUID();
  const written = await writeAssetBytes({
    assetDir: input.context.env.assetDir,
    projectId: input.run.projectId,
    assetId,
    mimeType: "image/png",
    bytes: input.bytes,
  });

  return {
    id: assetId,
    kind: input.kind,
    relativePath: written.relativePath,
    sha256: written.sha256,
    bytes: input.bytes.length,
    width: input.width,
    height: input.height,
    createdAt: Date.now(),
  };
}

function assetRow(run: RunRow, asset: SavedMaskAsset) {
  return {
    id: asset.id,
    projectId: run.projectId,
    kind: asset.kind,
    relativePath: asset.relativePath,
    sha256: asset.sha256,
    mimeType: "image/png" as const,
    width: asset.width,
    height: asset.height,
    bytes: asset.bytes,
    createdAt: asset.createdAt,
  };
}

function receiptMetadata(
  run: RunRow,
  snapshot: SegmentSnapshot,
  result: Extract<SegmentationAdapterResult, { kind: "mask" }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionMode: run.executionMode,
    model: snapshot.model,
    parserVersion: snapshot.parserVersion,
    promptVersion: snapshot.promptVersion,
    providerRequestId: result.providerRequestId,
    usage: result.usage,
    observedCostUsdMicros: result.observedCostUsdMicros,
    latencyMs: result.latencyMs,
    capture: snapshot.capture,
    ...extra,
  };
}

function saveSamRecordsReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: SegmentSnapshot,
  result: Extract<SegmentationAdapterResult, { kind: "mask"; representation: "sam-records" }>,
): void {
  context.db
    .update(runs)
    .set({
      providerReceiptJson: {
        kind: "segment",
        representation: "sam-records",
        complete: true,
        records: result.records,
        responseMetadata: receiptMetadata(run, snapshot, result),
      },
      stage: "processing",
    })
    .where(eq(runs.id, run.id))
    .run();
}

async function saveFullMaskReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: SegmentSnapshot,
  result: Extract<SegmentationAdapterResult, { kind: "mask"; representation: "full-mask" }>,
): Promise<void> {
  const maskBytes = await encodeMaskPng(result.fullMask, result.width, result.height);
  const maskAsset = await writeMaskAsset({
    context,
    run,
    kind: "selection_mask",
    bytes: maskBytes,
    width: result.width,
    height: result.height,
  });
  context.db.insert(assets).values(assetRow(run, maskAsset)).run();

  context.db
    .update(runs)
    .set({
      providerReceiptJson: {
        kind: "segment",
        representation: "full-mask-asset",
        complete: true,
        binaryMaskAssetId: maskAsset.id,
        responseMetadata: receiptMetadata(run, snapshot, result, {
          maskAssetSha256: maskAsset.sha256,
        }),
      },
      stage: "processing",
    })
    .where(eq(runs.id, run.id))
    .run();
}

function toRegionVariant(input: {
  paddingPx: 16 | 32;
  allowed: SavedMaskAsset;
  blend: SavedMaskAsset;
  boundingBox: RegionVariant["boundingBox"];
  percentages: RegionVariant["percentages"];
}): RegionVariant {
  return {
    paddingPx: input.paddingPx,
    allowedMaskAssetId: input.allowed.id,
    allowedMaskSha256: input.allowed.sha256,
    blendMaskAssetId: input.blend.id,
    blendMaskSha256: input.blend.sha256,
    boundingBox: input.boundingBox,
    percentages: input.percentages,
  };
}

async function persistSelection(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: SegmentSnapshot,
  fullMask: FullFrameMask,
): Promise<void> {
  const existing = findSelectionByRun(context.db, run.id);
  if (existing !== undefined) {
    markSegmentSucceeded(context.db, run, existing.id);
    return;
  }

  const positive = snapshot.positivePoints[0];
  if (positive === undefined) {
    throw new AppError(422, "INVALID_SELECTION", "Segmentation snapshot has no positive point.");
  }
  validateFullFrameMask({
    mask: fullMask.mask,
    width: fullMask.width,
    height: fullMask.height,
    positive,
    negative: snapshot.negativePoints[0] ?? null,
  });

  const selectionMaskBytes = await encodeMaskPng(fullMask.mask, fullMask.width, fullMask.height);
  const selectionMask = await writeMaskAsset({
    context,
    run,
    kind: "selection_mask",
    bytes: selectionMaskBytes,
    width: fullMask.width,
    height: fullMask.height,
  });

  const variants = new Map<
    16 | 32,
    {
      allowed: SavedMaskAsset;
      blend: SavedMaskAsset;
      boundingBox: RegionVariant["boundingBox"];
      percentages: RegionVariant["percentages"];
    }
  >();

  for (const paddingPx of MASK_PADDING_OPTIONS) {
    const variant = buildRegionMaskVariant(fullMask.mask, fullMask.width, fullMask.height, paddingPx);
    const allowedBytes = await encodeMaskPng(variant.allowedMask, fullMask.width, fullMask.height);
    const blendBytes = await encodeAlphaPng(variant.blendMask, fullMask.width, fullMask.height);
    const allowed = await writeMaskAsset({
      context,
      run,
      kind: "allowed_mask",
      bytes: allowedBytes,
      width: fullMask.width,
      height: fullMask.height,
    });
    const blend = await writeMaskAsset({
      context,
      run,
      kind: "blend_mask",
      bytes: blendBytes,
      width: fullMask.width,
      height: fullMask.height,
    });
    variants.set(paddingPx, {
      allowed,
      blend,
      boundingBox: variant.boundingBox,
      percentages: variant.percentages,
    });
  }

  const variant16 = variants.get(16);
  const variant32 = variants.get(32);
  if (variant16 === undefined || variant32 === undefined) {
    throw new AppError(500, "CONFIG_INVALID", "Region padding variants are incomplete.");
  }

  const regions = regionsSchema.parse({
    pipelineVersion: MASK_PIPELINE_VERSION,
    featherPx: MASK_FEATHER_PX,
    paddingPx: [16, 32],
    variants: {
      "16": toRegionVariant({ paddingPx: 16, ...variant16 }),
      "32": toRegionVariant({ paddingPx: 32, ...variant32 }),
    },
  });

  const selectionId = randomUUID();
  const now = Date.now();

  try {
    immediateTransaction(context.sqlite, () => {
      const concurrent = findSelectionByRun(context.db, run.id);
      if (concurrent !== undefined) {
        markSegmentSucceeded(context.db, run, concurrent.id);
        return;
      }

      context.db
        .insert(assets)
        .values(
          [selectionMask, variant16.allowed, variant16.blend, variant32.allowed, variant32.blend].map(
            (asset) => assetRow(run, asset),
          ),
        )
        .run();

      context.db
        .insert(selections)
        .values({
          id: selectionId,
          projectId: run.projectId,
          sourceVersionId: snapshot.sourceVersionId,
          originatingRunId: run.id,
          positivePointsJson: snapshot.positivePoints,
          negativePointsJson: snapshot.negativePoints,
          binaryMaskAssetId: selectionMask.id,
          regionsJson: regions,
          createdAt: now,
        })
        .run();

      markSegmentSucceeded(context.db, run, selectionId);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = findSelectionByRun(context.db, run.id);
      if (afterConstraint !== undefined) {
        markSegmentSucceeded(context.db, run, afterConstraint.id);
        return;
      }
    }
    throw error;
  }
}

async function resumeFromReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: SegmentSnapshot,
): Promise<void> {
  const receipt = parseProviderReceipt(run.providerReceiptJson);
  if (receipt === null || receipt.kind !== "segment") {
    markSegmentFailed(context, run, "INVALID_PROVIDER_OUTPUT", "The saved SAM receipt is unusable.");
    return;
  }

  if (receipt.representation === "sam-records") {
    let fullMask: FullFrameMask;
    try {
      fullMask = buildFullFrameMaskFromRecords({
        records: receipt.records,
        frameWidth: snapshot.width,
        frameHeight: snapshot.height,
        positive: snapshot.positivePoints[0],
        negative: snapshot.negativePoints[0] ?? null,
      });
    } catch {
      markSegmentFailed(
        context,
        run,
        "INVALID_SELECTION",
        "The saved SAM records no longer form a valid selection.",
      );
      return;
    }
    await persistSelection(context, run, snapshot, fullMask);
    return;
  }

  const maskAsset = context.db
    .select()
    .from(assets)
    .where(eq(assets.id, receipt.binaryMaskAssetId))
    .get();
  if (maskAsset === undefined || maskAsset.kind !== "selection_mask") {
    markSegmentFailed(context, run, "INVALID_PROVIDER_OUTPUT", "The saved SAM mask asset is missing.");
    return;
  }

  const bytes = await readAssetBytes(context.env.assetDir, maskAsset.relativePath);
  const decoded = await decodeMaskPng(bytes);
  if (decoded.width !== snapshot.width || decoded.height !== snapshot.height) {
    markSegmentFailed(context, run, "INVALID_PROVIDER_OUTPUT", "The saved SAM mask has wrong dimensions.");
    return;
  }

  await persistSelection(context, run, snapshot, decoded);
}

function createFixtureAdapter(
  context: RunHandlerContext,
  snapshot: SegmentSnapshot,
): SegmentationAdapter | null {
  if (snapshot.capture === null) return null;
  const lookup = loadSamCapture({
    repoRoot: context.env.repoRoot,
    sourceSha256: snapshot.sourceSha256,
    width: snapshot.width,
    height: snapshot.height,
    positivePoints: snapshot.positivePoints,
    negativePoints: snapshot.negativePoints,
  });
  if (
    lookup.status !== "ready" ||
    lookup.relativePath !== snapshot.capture.relativePath ||
    lookup.sha256 !== snapshot.capture.sha256
  ) {
    return null;
  }

  const replay = replaySamCapture(lookup.capture);
  return {
    segment: async () => ({
      kind: "mask",
      representation: "sam-records",
      records: replay.records,
      fullMask: replay.fullMask.mask,
      width: replay.fullMask.width,
      height: replay.fullMask.height,
      providerRequestId: null,
      observedCostUsdMicros: 0,
      usage: {
        sourceKind: "captured-live",
        captureDate: lookup.capture.captureDate,
        originalProviderRequestId: lookup.capture.providerRequestId,
        originalProviderLatencyMs: lookup.capture.providerLatencyMs,
        originalObservedCostUsdMicros: lookup.capture.observedCostUsdMicros,
      },
      latencyMs: null,
    }),
  };
}

export function createSegmentHandler(options: SegmentHandlerOptions = {}): RunHandler {
  return async (run, context) => {
    let snapshot: SegmentSnapshot;
    try {
      snapshot = parseSnapshot(run);
    } catch {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Segmentation input snapshot is invalid.",
        preProvider: true,
      });
      return;
    }

    if (run.providerReceiptJson !== null) {
      try {
        await resumeFromReceipt(context, run, snapshot);
      } catch {
        markSegmentFailed(context, run, "LOCAL_PROCESSING_FAILED", "Local selection processing failed.");
      }
      return;
    }

    if (run.providerStartedAt !== null) {
      markUsageUnknown(context.db, run.id);
      markNeedsReview(context.db, run, "The segmentation was dispatched but has no usable receipt.");
      return;
    }

    let adapter: SegmentationAdapter;
    if (options.adapterFactory !== undefined) {
      adapter = options.adapterFactory(run, context);
    } else if (run.executionMode === "mock") {
      adapter = createSegmentationAdapter(context.env, "mock");
    } else if (run.executionMode === "live") {
      if (context.env.metaModelApiKey === null) {
        markRunFailed(context.db, run, {
          code: "PROVIDER_UNAVAILABLE",
          message: "Meta SAM is not configured.",
          preProvider: true,
        });
        return;
      }
      adapter = createSegmentationAdapter(context.env, "live");
    } else {
      const fixtureAdapter = createFixtureAdapter(context, snapshot);
      if (fixtureAdapter === null) {
        markRunFailed(context.db, run, {
          code: "PROVIDER_UNAVAILABLE",
          message: "The SAM capture for this request is missing or no longer matches.",
          preProvider: true,
        });
        return;
      }
      adapter = fixtureAdapter;
    }

    let image: Buffer;
    try {
      image = await readSourceImage(context, snapshot);
    } catch {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "The source image is missing or no longer matches the snapshot.",
        preProvider: true,
      });
      return;
    }

    let calculatedCostUsdMicros: number;
    try {
      calculatedCostUsdMicros =
        run.executionMode === "live" ? getSegmentationCalculatedCostUsdMicros() : 0;
    } catch {
      markRunFailed(context.db, run, {
        code: "CONFIG_INVALID",
        message: "Meta SAM pricing is not configured.",
        preProvider: true,
      });
      return;
    }

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
        operation: "segment",
        provider:
          run.executionMode === "mock"
            ? "mock"
            : run.executionMode === "fixture"
              ? "fixture"
              : "meta",
        model: snapshot.model,
        executionMode: run.executionMode,
        pricingVersion: snapshot.pricingVersion,
        pricingSourceSnapshot: {
          kind: run.executionMode,
          pricingVersion: snapshot.pricingVersion,
          capabilityVersion: snapshot.capabilityVersion,
        },
      });
      return true;
    });

    if (!dispatched) return;

    let result: SegmentationAdapterResult;
    try {
      result = await adapter.segment({
        image,
        width: snapshot.width,
        height: snapshot.height,
        positive: snapshot.positivePoints[0],
        negative: snapshot.negativePoints[0] ?? null,
        prompt: snapshot.prompt,
      });
    } catch {
      markUsageUnknown(context.db, run.id);
      markNeedsReview(context.db, run, "The SAM provider outcome is unknown.");
      return;
    }

    settleResult(context, run, result, calculatedCostUsdMicros);

    if (result.kind === "ambiguous") {
      markNeedsReview(
        context.db,
        run,
        result.message,
        result.errorCode === "PROVIDER_TIMEOUT" ? "PROVIDER_TIMEOUT" : "INTERRUPTED",
      );
      return;
    }

    if (result.kind === "rejected") {
      markSegmentFailed(context, run, "PROVIDER_REJECTED", result.message);
      return;
    }

    if (result.kind === "invalid") {
      markSegmentFailed(context, run, "INVALID_SELECTION", result.message);
      return;
    }

    try {
      if (result.representation === "sam-records") {
        saveSamRecordsReceipt(context, run, snapshot, result);
      } else {
        await saveFullMaskReceipt(context, run, snapshot, result);
      }
      await persistSelection(context, run, snapshot, {
        mask: result.fullMask,
        width: result.width,
        height: result.height,
      });
    } catch {
      markSegmentFailed(context, run, "LOCAL_PROCESSING_FAILED", "Local selection processing failed.");
    }
  };
}

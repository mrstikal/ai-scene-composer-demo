import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { readAssetBytes, writeAssetBytes } from "../../assets/store";
import {
  generationSnapshotSchema,
  type GenerationSnapshot,
  type GenerationSourceMetadata,
} from "../../contracts/domain";
import type { AppDatabase } from "../../db/client";
import { assets, projects, runs, versions, type RunRow } from "../../db/schema";
import { immediateTransaction } from "../../db/transaction";
import { AppError } from "../../errors";
import { isUniqueConstraintError } from "../../idempotency/service";
import { normalizeProviderImage } from "../../images/normalize";
import { getProjectCommitmentMicros } from "../../budget/service";
import { markRunFailed } from "../queue";
import { parseProviderReceipt } from "../receipt";
import type { RunHandler, RunHandlerContext } from "../worker";
import { createPendingUsageEvent, markUsageUnknown, settleUsageEvent } from "../../usage/service";
import { createGenerationAdapter } from "../../providers/factory";
import type { ImageGenerationAdapter, ImageGenerationResult } from "../../providers/types";

export interface GenerateHandlerOptions {
  adapterFactory?: (run: RunRow, context: RunHandlerContext) => ImageGenerationAdapter;
}

function parseSnapshot(run: RunRow): GenerationSnapshot {
  const parsed = generationSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) {
    throw new AppError(422, "INVALID_RUN_STATE", "Generation input snapshot is invalid.");
  }
  return parsed.data;
}

function generationMetadata(snapshot: GenerationSnapshot): GenerationSourceMetadata {
  return {
    kind: "generation",
    mode: snapshot.mode,
    presetId: snapshot.presetId,
    presetVersion: snapshot.presetVersion,
    promptSha256: snapshot.promptSha256,
    model: snapshot.model,
    pricingVersion: snapshot.pricingVersion,
    capabilityVersion: snapshot.capabilityVersion,
  };
}

function settleResult(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: GenerationSnapshot,
  result: ImageGenerationResult,
): number | null {
  if (result.kind === "ambiguous") {
    markUsageUnknown(context.db, run.id);
    return null;
  }

  const observed = result.observedCostUsdMicros;
  const mock = run.executionMode === "mock";

  if (result.kind === "rejected") {
    const amount = observed ?? 0;
    settleUsageEvent(context.db, {
      runId: run.id,
      outcome: "rejected",
      amountUsdMicros: amount,
      costProvenance: mock ? "calculated" : observed === null ? "calculated" : "provider",
      usageJson: result.usage,
      providerRequestId: result.providerRequestId,
      elapsedMs: result.latencyMs,
    });
    context.db
      .update(runs)
      .set({
        budgetChargeUsdMicros: amount,
        providerFinishedAt: Date.now(),
      })
      .where(eq(runs.id, run.id))
      .run();
    return amount;
  }

  const amount = mock ? 0 : observed ?? snapshot.reservationUsdMicros;
  settleUsageEvent(context.db, {
    runId: run.id,
    outcome: "completed",
    amountUsdMicros: amount,
    costProvenance: mock ? "calculated" : observed !== null ? "provider" : "estimated",
    usageJson: result.usage,
    providerRequestId: result.providerRequestId,
    elapsedMs: result.latencyMs,
  });
  context.db
    .update(runs)
    .set({
      budgetChargeUsdMicros: amount,
      providerFinishedAt: Date.now(),
    })
    .where(eq(runs.id, run.id))
    .run();
  return amount;
}

function markNeedsReview(db: AppDatabase, run: RunRow, message: string): void {
  db.update(runs)
    .set({
      status: "needs_review",
      stage: "error",
      finishedAt: Date.now(),
      errorCode: "INTERRUPTED",
      errorMessage: message,
    })
    .where(eq(runs.id, run.id))
    .run();
}

async function saveRawAsset(
  context: RunHandlerContext,
  run: RunRow,
  input: {
    bytes: Buffer;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
  },
): Promise<string> {
  const assetId = randomUUID();
  const written = await writeAssetBytes({
    assetDir: context.env.assetDir,
    projectId: run.projectId,
    assetId,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  const now = Date.now();

  context.db
    .insert(assets)
    .values({
      id: assetId,
      projectId: run.projectId,
      kind: "raw",
      relativePath: written.relativePath,
      sha256: written.sha256,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      bytes: input.bytes.length,
      createdAt: now,
    })
    .run();

  return assetId;
}

async function saveCanonicalAsset(
  context: RunHandlerContext,
  run: RunRow,
  bytes: Buffer,
  width: number,
  height: number,
): Promise<string> {
  const assetId = randomUUID();
  const written = await writeAssetBytes({
    assetDir: context.env.assetDir,
    projectId: run.projectId,
    assetId,
    mimeType: "image/png",
    bytes,
  });

  context.db
    .insert(assets)
    .values({
      id: assetId,
      projectId: run.projectId,
      kind: "canonical",
      relativePath: written.relativePath,
      sha256: written.sha256,
      mimeType: "image/png",
      width,
      height,
      bytes: bytes.length,
      createdAt: Date.now(),
    })
    .run();

  return assetId;
}

function installRoot(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: GenerationSnapshot,
  rawAssetId: string,
  canonicalAssetId: string,
): void {
  const versionId = randomUUID();
  const now = Date.now();

  try {
    immediateTransaction(context.sqlite, () => {
      const project = context.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
      if (project === undefined) {
        throw new AppError(404, "NOT_FOUND", "Project was not found.");
      }
      if (project.rootVersionId !== null) {
        throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
      }

      const existingRoot = context.db
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.projectId, run.projectId), isNull(versions.parentVersionId)))
        .get();
      if (existingRoot !== undefined) {
        throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
      }

      context.db
        .insert(versions)
        .values({
          id: versionId,
          projectId: run.projectId,
          parentVersionId: null,
          imageAssetId: canonicalAssetId,
          origin: "generate",
          originalAssetId: rawAssetId,
          sourceMetadataJson: generationMetadata(snapshot),
          originatingRunId: run.id,
          createdAt: now,
        })
        .run();

      context.db
        .update(projects)
        .set({ rootVersionId: versionId, activeVersionId: versionId })
        .where(eq(projects.id, run.projectId))
        .run();

      context.db
        .update(runs)
        .set({
          status: "succeeded",
          stage: "done",
          finishedAt: now,
          outputVersionId: versionId,
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(runs.id, run.id))
        .run();
    });
  } catch (error) {
    if (
      (error instanceof AppError && error.code === "ROOT_ALREADY_EXISTS") ||
      isUniqueConstraintError(error)
    ) {
      markRunFailed(context.db, run, {
        code: "ROOT_ALREADY_EXISTS",
        message: "Another root scene was installed before this generation completed.",
        preProvider: false,
      });
      return;
    }
    throw error;
  }
}

async function persistImage(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: GenerationSnapshot,
  result: Extract<ImageGenerationResult, { kind: "image" }>,
): Promise<void> {
  const rawAssetId = await saveRawAsset(context, run, {
    bytes: result.bytes,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
  });
  const normalized = await normalizeProviderImage(result.bytes);
  const canonicalAssetId = await saveCanonicalAsset(
    context,
    run,
    normalized.bytes,
    normalized.width,
    normalized.height,
  );

  immediateTransaction(context.sqlite, () => {
    context.db
      .update(runs)
      .set({
        rawAssetId,
        normalizedRawAssetId: canonicalAssetId,
        providerReceiptJson: {
          kind: "image",
          complete: true,
          rawAssetId,
          responseMetadata: {
            providerRequestId: result.providerRequestId,
            usage: result.usage,
            observedCostUsdMicros: result.observedCostUsdMicros,
            latencyMs: result.latencyMs,
            nativeWidth: result.width,
            nativeHeight: result.height,
            mimeType: result.mimeType,
          },
        },
        stage: "processing",
      })
      .where(eq(runs.id, run.id))
      .run();
  });

  installRoot(context, run, snapshot, rawAssetId, canonicalAssetId);
}

async function persistInvalid(
  context: RunHandlerContext,
  run: RunRow,
  result: Extract<ImageGenerationResult, { kind: "invalid" }>,
): Promise<void> {
  if (result.bytes !== undefined && result.mimeType !== undefined) {
    const rawAssetId = await saveRawAsset(context, run, {
      bytes: result.bytes,
      mimeType: result.mimeType,
      width: result.width ?? 0,
      height: result.height ?? 0,
    });
    context.db
      .update(runs)
      .set({ rawAssetId, stage: "processing" })
      .where(eq(runs.id, run.id))
      .run();
  }

  markRunFailed(context.db, run, {
    code: "INVALID_PROVIDER_OUTPUT",
    message: result.message,
    preProvider: false,
  });
}

async function resumeFromReceipt(
  context: RunHandlerContext,
  run: RunRow,
  snapshot: GenerationSnapshot,
): Promise<void> {
  const receipt = parseProviderReceipt(run.providerReceiptJson);
  if (receipt === null || receipt.kind !== "image") {
    markRunFailed(context.db, run, {
      code: "INVALID_PROVIDER_OUTPUT",
      message: "The saved provider receipt is unusable.",
      preProvider: false,
    });
    return;
  }

  if (run.normalizedRawAssetId !== null) {
    const normalizedAsset = context.db
      .select()
      .from(assets)
      .where(eq(assets.id, run.normalizedRawAssetId))
      .get();
    if (normalizedAsset === undefined) {
      markRunFailed(context.db, run, {
        code: "INVALID_PROVIDER_OUTPUT",
        message: "The saved normalized provider asset is missing.",
        preProvider: false,
      });
      return;
    }
    installRoot(context, run, snapshot, receipt.rawAssetId, run.normalizedRawAssetId);
    return;
  }

  const rawAsset = context.db.select().from(assets).where(eq(assets.id, receipt.rawAssetId)).get();
  if (rawAsset === undefined) {
    markRunFailed(context.db, run, {
      code: "INVALID_PROVIDER_OUTPUT",
      message: "The saved raw provider asset is missing.",
      preProvider: false,
    });
    return;
  }

  let normalized;
  try {
    const bytes = await readAssetBytes(context.env.assetDir, rawAsset.relativePath);
    normalized = await normalizeProviderImage(bytes);
  } catch {
    markRunFailed(context.db, run, {
      code: "INVALID_PROVIDER_OUTPUT",
      message: "The saved raw provider image is unusable.",
      preProvider: false,
    });
    return;
  }

  const canonicalAssetId = await saveCanonicalAsset(
    context,
    run,
    normalized.bytes,
    normalized.width,
    normalized.height,
  );

  context.db
    .update(runs)
    .set({ normalizedRawAssetId: canonicalAssetId, stage: "processing" })
    .where(eq(runs.id, run.id))
    .run();

  installRoot(context, run, snapshot, receipt.rawAssetId, canonicalAssetId);
}

export function createGenerateHandler(options: GenerateHandlerOptions = {}): RunHandler {
  return async (run, context) => {
    let snapshot: GenerationSnapshot;
    try {
      snapshot = parseSnapshot(run);
    } catch {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Generation input snapshot is invalid.",
        preProvider: true,
      });
      return;
    }

    if (run.providerReceiptJson !== null) {
      try {
        await resumeFromReceipt(context, run, snapshot);
      } catch {
        markRunFailed(context.db, run, {
          code: "LOCAL_PROCESSING_FAILED",
          message: "Local generation processing failed.",
          preProvider: false,
        });
      }
      return;
    }

    if (run.providerStartedAt !== null) {
      markUsageUnknown(context.db, run.id);
      markNeedsReview(
        context.db,
        run,
        "The generation was dispatched but has no usable receipt.",
      );
      return;
    }

    if (run.executionMode === "live") {
      if (context.env.openRouterApiKey === null) {
        markRunFailed(context.db, run, {
          code: "PROVIDER_UNAVAILABLE",
          message: "OpenRouter is not configured.",
          preProvider: true,
        });
        return;
      }

    }

    if (run.executionMode === "fixture") {
      markRunFailed(context.db, run, {
        code: "INVALID_RUN_STATE",
        message: "Fixture mode is not valid for generation.",
        preProvider: true,
      });
      return;
    }

    const adapter =
      options.adapterFactory?.(run, context) ??
      createGenerationAdapter(context.env, run.executionMode);

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
        operation: "generate",
        provider: run.executionMode === "mock" ? "mock" : "openrouter",
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

    let result: ImageGenerationResult;
    try {
      result = await adapter.generate({
        model: snapshot.model,
        prompt: snapshot.prompt,
      });
    } catch {
      markUsageUnknown(context.db, run.id);
      markNeedsReview(context.db, run, "The provider outcome is unknown.");
      return;
    }

    settleResult(context, run, snapshot, result);

    if (result.kind === "ambiguous") {
      markNeedsReview(context.db, run, result.message);
      return;
    }

    try {
      if (result.kind === "image") {
        await persistImage(context, run, snapshot, result);
      } else if (result.kind === "invalid") {
        await persistInvalid(context, run, result);
      } else {
        markRunFailed(context.db, run, {
          code: "PROVIDER_REJECTED",
          message: result.message,
          preProvider: false,
        });
      }
    } catch {
      markRunFailed(context.db, run, {
        code: "LOCAL_PROCESSING_FAILED",
        message: "Local generation processing failed.",
        preProvider: false,
      });
    }
  };
}

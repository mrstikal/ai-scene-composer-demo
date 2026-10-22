import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { assertCompatibleConfig, getPricingConfig, getProviderCapabilities } from "../config/pricing";
import type { AppEnv } from "../config/env";
import type { CostConsent, RetryResponse } from "../contracts/api";
import {
  editSnapshotSchema,
  generationSnapshotSchema,
  segmentSnapshotSchema,
  type EditSnapshot,
} from "../contracts/domain";
import type { DatabaseHandle } from "../db/client";
import { assets, runs, versions, type RunRow } from "../db/schema";
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
import { assertProjectCanCreateRoot } from "../projects/service";
import {
  segmentationExecutionMode,
  segmentationReservationUsdMicros,
} from "../segmentations/service";
import { assertEditInputsAvailable } from "../edits/service";
import { buildEditCommonInputHash } from "../edits/common-input";
import { assertReservationAllowed } from "../budget/service";
import { getUsageEventByRunId } from "../usage/service";
import { classifyRetryMode } from "./retry-mode";

export function getRunOrThrow(db: DatabaseHandle["db"], runId: string): RunRow {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) {
    throw new AppError(404, "NOT_FOUND", "Run was not found.");
  }
  return run;
}

function validateRetryConsent(
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

export async function enqueueRetry(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  runId: string;
  costConsent: CostConsent;
  acknowledgePossibleDuplicateCharge: boolean;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, runId, costConsent, acknowledgePossibleDuplicateCharge, idempotencyKey } = input;
  const { db, sqlite } = handle;
  assertCompatibleConfig();
  const original = getRunOrThrow(db, runId);
  const usage = getUsageEventByRunId(db, runId);
  const retryMode = classifyRetryMode(original, usage);
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();

  if (retryMode === "none") {
    throw new AppError(422, "INVALID_RUN_STATE", "This run cannot be retried.");
  }

  if (retryMode === "local") {
    validateRetryConsent(costConsent, pricing.version, 0);
    const operation = "retry_local";
    const requestHash = hashRequest({ operation, runId, costConsent });
    const replay = replayIdempotent(findIdempotency(db, original.projectId, idempotencyKey), operation, requestHash);
    if (replay !== null) return replay;

    const response: StoredIdempotentResponse = {
      status: 202,
      body: { runId } satisfies RetryResponse,
    };
    let replayResult: StoredIdempotentResponse | null = null;

    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayIdempotent(
        findIdempotency(db, original.projectId, idempotencyKey),
        operation,
        requestHash,
      );
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      const current = getRunOrThrow(db, runId);
      if (current.status !== "failed" && current.status !== "needs_review") {
        throw new AppError(422, "INVALID_RUN_STATE", "This run cannot be retried.");
      }

      db.update(runs)
        .set({
          status: "queued",
          stage: "processing",
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(runs.id, runId))
        .run();

      insertIdempotency(db, {
        projectId: original.projectId,
        key: idempotencyKey,
        operation,
        requestHash,
        response,
      });
    });

    if (replayResult !== null) return replayResult;
    return response;
  }

  const isSegment = original.kind === "segment";
  const isEdit = original.kind === "edit";
  const executionMode = isSegment ? segmentationExecutionMode(env) : env.aiMode;
  const reservationUsdMicros = isSegment
    ? segmentationReservationUsdMicros(env)
    : env.aiMode === "mock"
      ? 0
      : env.imageReservationUsdMicros;
  validateRetryConsent(costConsent, pricing.version, reservationUsdMicros);

  if (isSegment && executionMode === "fixture") {
    throw new AppError(
      503,
      "PROVIDER_UNAVAILABLE",
      "A provider retry cannot run from a SAM fixture. Switch to live SAM.",
    );
  }

  if (executionMode === "live") {
    if (isSegment && env.metaModelApiKey === null) {
      throw new AppError(503, "PROVIDER_UNAVAILABLE", "Meta SAM is not configured.");
    }
    if (!isSegment && env.openRouterApiKey === null) {
      throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
    }
  }

  const unknownCharge =
    original.providerStartedAt !== null
      ? usage === undefined || usage.outcome === "unknown" || usage.amountUsdMicros === null
      : usage !== undefined && (usage.outcome === "unknown" || usage.outcome === "pending");

  if (!acknowledgePossibleDuplicateCharge && unknownCharge) {
    throw new AppError(
      400,
      "INVALID_REQUEST",
      "Acknowledge that a retry may create a duplicate provider charge.",
    );
  }

  let snapshot:
    | ReturnType<typeof generationSnapshotSchema.parse>
    | ReturnType<typeof segmentSnapshotSchema.parse>
    | EditSnapshot;
  let commonInputHash: string | null;
  if (isSegment) {
    const originalSegment = segmentSnapshotSchema.safeParse(original.inputSnapshotJson);
    if (!originalSegment.success) {
      throw new AppError(422, "INVALID_RUN_STATE", "The original segmentation input is not retryable.");
    }
    snapshot = segmentSnapshotSchema.parse({
      ...originalSegment.data,
      executionMode,
      pricingVersion: pricing.version,
      capabilityVersion: capabilities.version,
      reservationUsdMicros,
      capture: null,
    });
    commonInputHash = null;
  } else if (isEdit) {
    const originalEdit = editSnapshotSchema.safeParse(original.inputSnapshotJson);
    if (!originalEdit.success) {
      throw new AppError(422, "INVALID_RUN_STATE", "The original edit input is not retryable.");
    }
    const parsedEdit = editSnapshotSchema.parse({
      ...originalEdit.data,
      executionMode: env.aiMode,
      pricingVersion: pricing.version,
      capabilityVersion: capabilities.version,
      reservationUsdMicros,
    });
    snapshot = parsedEdit;
    commonInputHash = original.commonInputHash ?? buildEditCommonInputHash(parsedEdit);
  } else {
    const originalSnapshot = generationSnapshotSchema.safeParse(original.inputSnapshotJson);
    if (!originalSnapshot.success) {
      throw new AppError(422, "INVALID_RUN_STATE", "The original generation input is not retryable.");
    }
    const parsedGeneration = generationSnapshotSchema.parse({
      ...originalSnapshot.data,
      executionMode: env.aiMode,
      pricingVersion: pricing.version,
      capabilityVersion: capabilities.version,
      reservationUsdMicros,
    });
    snapshot = parsedGeneration;
    commonInputHash = parsedGeneration.promptSha256;
  }
  const operation = "retry_provider";
  const requestHash = hashRequest({
    operation,
    runId,
    costConsent,
    acknowledgePossibleDuplicateCharge,
    snapshot,
  });
  const replay = replayIdempotent(findIdempotency(db, original.projectId, idempotencyKey), operation, requestHash);
  if (replay !== null) return replay;

  const newRunId = randomUUID();
  const response: StoredIdempotentResponse = {
    status: 202,
    body: { runId: newRunId } satisfies RetryResponse,
  };
  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayIdempotent(
        findIdempotency(db, original.projectId, idempotencyKey),
        operation,
        requestHash,
      );
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      const currentOriginal = getRunOrThrow(db, runId);
      const currentUsage = getUsageEventByRunId(db, runId);
      if (classifyRetryMode(currentOriginal, currentUsage) !== "provider") {
        throw new AppError(422, "INVALID_RUN_STATE", "This run cannot be retried.");
      }

      if (isEdit) {
        assertEditInputsAvailable(db, original.projectId, snapshot as EditSnapshot);
      } else if (isSegment) {
        const sourceVersionId = original.parentVersionId;
        if (sourceVersionId === null) {
          throw new AppError(422, "INVALID_RUN_STATE", "The segmentation source version is missing.");
        }
        const sourceVersion = db
          .select()
          .from(versions)
          .where(and(eq(versions.id, sourceVersionId), eq(versions.projectId, original.projectId)))
          .get();
        if (sourceVersion === undefined) {
          throw new AppError(422, "INVALID_RUN_STATE", "The segmentation source version is missing.");
        }
        const sourceAsset = db
          .select()
          .from(assets)
          .where(eq(assets.id, sourceVersion.imageAssetId))
          .get();
        if (sourceAsset === undefined) {
          throw new AppError(422, "INVALID_RUN_STATE", "The segmentation source asset is missing.");
        }
      } else {
        assertProjectCanCreateRoot(db, original.projectId);
      }

      const existingRetry = db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.retryOfRunId, runId))
        .get();
      if (existingRetry !== undefined) {
        throw new AppError(409, "RETRY_EXISTS", "A retry already exists for this run.");
      }

      assertReservationAllowed(db, original.projectId, reservationUsdMicros);

      db.insert(runs)
        .values({
          id: newRunId,
          projectId: original.projectId,
          kind: original.kind,
          executionMode,
          comparisonGroupId: original.comparisonGroupId,
          retryOfRunId: runId,
          parentVersionId: isSegment || isEdit ? original.parentVersionId : null,
          inputSelectionId: isEdit ? original.inputSelectionId : null,
          model: snapshot.model,
          inputSnapshotJson: snapshot,
          commonInputHash,
          status: "queued",
          stage: "queued",
          reservedUsdMicros: reservationUsdMicros,
          budgetChargeUsdMicros: reservationUsdMicros,
          createdAt: Date.now(),
        })
        .run();

      insertIdempotency(db, {
        projectId: original.projectId,
        key: idempotencyKey,
        operation,
        requestHash,
        response,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = replayIdempotent(
        findIdempotency(db, original.projectId, idempotencyKey),
        operation,
        requestHash,
      );
      if (afterConstraint !== null) return afterConstraint;
      throw new AppError(409, "RETRY_EXISTS", "A retry already exists for this run.");
    }
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

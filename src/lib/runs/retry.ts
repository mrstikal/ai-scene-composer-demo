import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { assertCompatibleConfig, getPricingConfig, getProviderCapabilities } from "../config/pricing";
import type { AppEnv } from "../config/env";
import type { CostConsent, RetryResponse } from "../contracts/api";
import { generationSnapshotSchema } from "../contracts/domain";
import type { DatabaseHandle } from "../db/client";
import { runs, type RunRow } from "../db/schema";
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

  const reservationUsdMicros = env.aiMode === "mock" ? 0 : env.imageReservationUsdMicros;
  validateRetryConsent(costConsent, pricing.version, reservationUsdMicros);

  if (env.aiMode === "live" && env.openRouterApiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
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

  const originalSnapshot = generationSnapshotSchema.safeParse(original.inputSnapshotJson);
  if (!originalSnapshot.success) {
    throw new AppError(422, "INVALID_RUN_STATE", "The original generation input is not retryable.");
  }

  const snapshot = generationSnapshotSchema.parse({
    ...originalSnapshot.data,
    executionMode: env.aiMode,
    pricingVersion: pricing.version,
    capabilityVersion: capabilities.version,
    reservationUsdMicros,
  });
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

      assertProjectCanCreateRoot(db, original.projectId);
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
          kind: "generate",
          executionMode: env.aiMode,
          comparisonGroupId: null,
          retryOfRunId: runId,
          parentVersionId: null,
          inputSelectionId: null,
          model: snapshot.model,
          inputSnapshotJson: snapshot,
          commonInputHash: snapshot.promptSha256,
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

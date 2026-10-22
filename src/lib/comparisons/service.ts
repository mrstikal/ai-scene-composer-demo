import { randomUUID } from "node:crypto";

import type { AppEnv } from "../config/env";
import { assertCompatibleConfig, getPricingConfig, getProviderCapabilities } from "../config/pricing";
import type { ComparisonResponse, CostConsent } from "../contracts/api";
import { COMPARISON_MODELS, type ComparisonModel, type EditScope } from "../contracts/domain";
import type { DatabaseHandle } from "../db/client";
import { runs } from "../db/schema";
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
import { getProjectOrThrow } from "../projects/service";
import { normalizeEditText, prepareEditSnapshot } from "../edits/service";

export type ComparisonExecutionMode = "mock" | "live";

export function comparisonExecutionMode(env: AppEnv): ComparisonExecutionMode {
  return env.aiMode;
}

export function comparisonCandidateReservationUsdMicros(env: AppEnv): number {
  return env.aiMode === "mock" ? 0 : env.imageReservationUsdMicros;
}

export function comparisonReservationUsdMicros(env: AppEnv): number {
  const total = comparisonCandidateReservationUsdMicros(env) * COMPARISON_MODELS.length;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new AppError(500, "CONFIG_INVALID", "The comparison reservation is invalid.");
  }
  return total;
}

function validateComparisonConsent(
  consent: CostConsent,
  pricingVersion: string,
  reservationUsdMicros: number,
): void {
  if (consent.pricingVersion !== pricingVersion) {
    throw new AppError(409, "PRICING_CHANGED", "The pricing version changed. Refresh the project and retry.");
  }
  if (consent.reservationUsdMicros !== reservationUsdMicros) {
    throw new AppError(409, "PRICING_CHANGED", "The comparison reservation changed. Refresh the project and retry.");
  }
}

export async function enqueueComparison(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  parentVersionId: string;
  scope: EditScope;
  selectionId?: string;
  paddingPx?: 16 | 32;
  targetLabel?: string | undefined;
  instruction: string;
  referenceAssetIds: string[];
  costConsent: CostConsent;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, idempotencyKey } = input;
  const { db, sqlite } = handle;
  const text = normalizeEditText({
    scope: input.scope,
    targetLabel: input.targetLabel,
    instruction: input.instruction,
  });
  const requestHash = hashRequest({
    operation: "comparison",
    projectId,
    parentVersionId: input.parentVersionId,
    scope: input.scope,
    selectionId: input.selectionId,
    paddingPx: input.paddingPx,
    targetLabel: text.targetLabel,
    instruction: text.instruction,
    referenceAssetIds: input.referenceAssetIds,
  });
  const replay = replayIdempotent(findIdempotency(db, projectId, idempotencyKey), "comparison", requestHash);
  if (replay !== null) return replay;

  assertCompatibleConfig();
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();
  const executionMode = comparisonExecutionMode(env);
  const reservationUsdMicros = comparisonReservationUsdMicros(env);
  const candidateReservationUsdMicros = comparisonCandidateReservationUsdMicros(env);

  for (const model of COMPARISON_MODELS) {
    if (pricing.providers.openrouter.models[model] === undefined) {
      throw new AppError(503, "PROVIDER_UNAVAILABLE", "A comparison edit model is not configured.");
    }
  }

  validateComparisonConsent(input.costConsent, pricing.version, reservationUsdMicros);
  if (executionMode === "live" && env.openRouterApiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
  }

  const comparisonGroupId = randomUUID();
  const runIds = COMPARISON_MODELS.map(() => randomUUID()) as [string, string];
  const response: StoredIdempotentResponse = {
    status: 202,
    body: {
      comparisonGroupId,
      runIds,
    } satisfies ComparisonResponse,
  };
  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        "comparison",
        requestHash,
      );
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      getProjectOrThrow(db, projectId);

      const prepared = COMPARISON_MODELS.map((model: ComparisonModel) =>
        prepareEditSnapshot({
          db,
          env,
          projectId,
          parentVersionId: input.parentVersionId,
          scope: input.scope,
          selectionId: input.selectionId,
          paddingPx: input.paddingPx,
          targetLabel: text.targetLabel,
          instruction: text.instruction,
          referenceAssetIds: input.referenceAssetIds,
          model,
          reservationUsdMicros: candidateReservationUsdMicros,
          pricingVersion: pricing.version,
          capabilityVersion: capabilities.version,
        }),
      );

      const first = prepared[0];
      const second = prepared[1];
      if (first === undefined || second === undefined) {
        throw new AppError(500, "CONFIG_INVALID", "Comparison models are not configured.");
      }
      if (first.commonInputHash !== second.commonInputHash) {
        throw new AppError(500, "CONFIG_INVALID", "Comparison candidates do not share identical input.");
      }

      assertReservationAllowed(db, projectId, reservationUsdMicros);

      const now = Date.now();
      prepared.forEach((entry, index) => {
        const model = COMPARISON_MODELS[index];
        const runId = runIds[index];
        if (model === undefined || runId === undefined) {
          throw new AppError(500, "CONFIG_INVALID", "Comparison candidate configuration is invalid.");
        }
        db.insert(runs)
          .values({
            id: runId,
            projectId,
            kind: "edit",
            executionMode,
            comparisonGroupId,
            retryOfRunId: null,
            parentVersionId: input.parentVersionId,
            inputSelectionId: entry.selection?.id ?? null,
            model,
            inputSnapshotJson: entry.snapshot,
            commonInputHash: entry.commonInputHash,
            status: "queued",
            stage: "queued",
            reservedUsdMicros: candidateReservationUsdMicros,
            budgetChargeUsdMicros: candidateReservationUsdMicros,
            createdAt: now,
          })
          .run();
      });

      insertIdempotency(db, {
        projectId,
        key: idempotencyKey,
        operation: "comparison",
        requestHash,
        response,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        "comparison",
        requestHash,
      );
      if (afterConstraint !== null) return afterConstraint;
    }
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

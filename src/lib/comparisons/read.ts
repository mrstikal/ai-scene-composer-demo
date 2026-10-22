import { asc, eq, sql } from "drizzle-orm";

import type { AppEnv } from "../config/env";
import type {
  ComparisonCandidateCostDto,
  ComparisonDetailDto,
  ComparisonModelCostDto,
  ComparisonSharedSelectionCostDto,
  RunSummaryDto,
} from "../contracts/api";
import { COMPARISON_MODELS } from "../contracts/domain";
import type { AppDatabase } from "../db/client";
import { runs, selections, usageEvents, type RunRow, type UsageEventRow } from "../db/schema";
import { AppError } from "../errors";
import { toRunSummary } from "../projects/service";

interface CandidateCostAccumulator {
  knownUsdMicros: number;
  unknownAmountRuns: number;
  pendingRuns: number;
  runIds: string[];
}

function emptyAccumulator(): CandidateCostAccumulator {
  return { knownUsdMicros: 0, unknownAmountRuns: 0, pendingRuns: 0, runIds: [] };
}

type ComparisonRunSource = Pick<
  RunRow,
  "id" | "model" | "status" | "budgetChargeUsdMicros"
>;
type ComparisonUsageSource = Pick<
  UsageEventRow,
  "amountUsdMicros" | "settledAt"
>;

function accumulateRunCost(
  accumulator: CandidateCostAccumulator,
  run: ComparisonRunSource,
  usage: ComparisonUsageSource | undefined,
): void {
  accumulator.runIds.push(run.id);

  if (usage !== undefined && usage.settledAt !== null) {
    if (usage.amountUsdMicros !== null) {
      accumulator.knownUsdMicros += usage.amountUsdMicros;
    } else {
      accumulator.unknownAmountRuns += 1;
    }
    return;
  }

  if (run.status === "queued" || run.status === "running") {
    accumulator.pendingRuns += 1;
    return;
  }

  if (run.budgetChargeUsdMicros > 0) {
    accumulator.unknownAmountRuns += 1;
  }
}

function modelRank(model: string): number {
  const index = (COMPARISON_MODELS as readonly string[]).indexOf(model);
  return index === -1 ? COMPARISON_MODELS.length : index;
}

function summarizeCandidateCost(
  groupRuns: ComparisonRunSource[],
  usageByRunId: Map<string, ComparisonUsageSource>,
): ComparisonCandidateCostDto {
  const total = emptyAccumulator();
  const byModel = new Map<string, CandidateCostAccumulator>();

  for (const run of groupRuns) {
    const usage = usageByRunId.get(run.id);
    accumulateRunCost(total, run, usage);
    const modelAccumulator = byModel.get(run.model) ?? emptyAccumulator();
    accumulateRunCost(modelAccumulator, run, usage);
    byModel.set(run.model, modelAccumulator);
  }

  const models: ComparisonModelCostDto[] = [...byModel.entries()]
    .sort(([left], [right]) => {
      const rank = modelRank(left) - modelRank(right);
      return rank !== 0 ? rank : left.localeCompare(right);
    })
    .map(([model, accumulator]) => ({
      model,
      runIds: accumulator.runIds,
      knownUsdMicros: accumulator.knownUsdMicros,
      unknownAmountRuns: accumulator.unknownAmountRuns,
      pendingRuns: accumulator.pendingRuns,
    }));

  return {
    knownUsdMicros: total.knownUsdMicros,
    unknownAmountRuns: total.unknownAmountRuns,
    pendingRuns: total.pendingRuns,
    byModel: models,
  };
}

function sharedSelectionCost(
  db: AppDatabase,
  groupRuns: Array<Pick<RunRow, "inputSelectionId">>,
): ComparisonSharedSelectionCostDto | null {
  const selectionId = groupRuns.find((run) => run.inputSelectionId !== null)?.inputSelectionId;
  if (selectionId === null || selectionId === undefined) return null;

  const selection = db.select().from(selections).where(eq(selections.id, selectionId)).get();
  if (selection === undefined) return null;

  const segmentRun = db
    .select()
    .from(runs)
    .where(eq(runs.id, selection.originatingRunId))
    .get();
  const usage =
    segmentRun === undefined
      ? undefined
      : db.select().from(usageEvents).where(eq(usageEvents.runId, segmentRun.id)).get();

  return {
    selectionId: selection.id,
    runId: selection.originatingRunId,
    model: segmentRun?.model ?? "unknown",
    amountUsdMicros: usage?.amountUsdMicros ?? null,
    provenance: usage?.costProvenance ?? null,
    outcome: usage?.outcome ?? null,
  };
}

export function getComparisonDetail(
  db: AppDatabase,
  comparisonGroupId: string,
  env?: Pick<AppEnv, "imageReservationUsdMicros" | "aiMode" | "samMode">,
): ComparisonDetailDto {
  return db.transaction(
    (tx) => {
      const runSelection = {
        id: runs.id,
        projectId: runs.projectId,
        kind: runs.kind,
        executionMode: runs.executionMode,
        comparisonGroupId: runs.comparisonGroupId,
        retryOfRunId: runs.retryOfRunId,
        parentVersionId: runs.parentVersionId,
        inputSelectionId: runs.inputSelectionId,
        model: runs.model,
        inputSnapshotJson: runs.inputSnapshotJson,
        commonInputHash: runs.commonInputHash,
        status: runs.status,
        stage: runs.stage,
        reservedUsdMicros: runs.reservedUsdMicros,
        budgetChargeUsdMicros: runs.budgetChargeUsdMicros,
        rawAssetId: runs.rawAssetId,
        normalizedRawAssetId: runs.normalizedRawAssetId,
        outputSelectionId: runs.outputSelectionId,
        outputVersionId: runs.outputVersionId,
        metricsJson: runs.metricsJson,
        evaluationJson: runs.evaluationJson,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        providerStartedAt: runs.providerStartedAt,
        providerFinishedAt: runs.providerFinishedAt,
        finishedAt: runs.finishedAt,
        errorCode: runs.errorCode,
        errorMessage: runs.errorMessage,
        providerReceiptKind: sql<"image" | "segment" | null>`json_extract(${runs.providerReceiptJson}, '$.kind')`,
      };

      const groupRuns = tx
        .select(runSelection)
        .from(runs)
        .where(eq(runs.comparisonGroupId, comparisonGroupId))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all();

      if (groupRuns.length === 0) {
        throw new AppError(404, "NOT_FOUND", "Comparison group was not found.");
      }

      const orderedRuns = [...groupRuns].sort((left, right) => {
        const rank = modelRank(left.model) - modelRank(right.model);
        if (rank !== 0) return rank;
        if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
        return left.id.localeCompare(right.id);
      });

      const usageRows = tx
        .select({
          runId: usageEvents.runId,
          outcome: usageEvents.outcome,
          amountUsdMicros: usageEvents.amountUsdMicros,
          costProvenance: usageEvents.costProvenance,
          elapsedMs: usageEvents.elapsedMs,
          settledAt: usageEvents.settledAt,
        })
        .from(usageEvents)
        .where(eq(usageEvents.projectId, groupRuns[0]!.projectId))
        .all();
      const usageByRunId = new Map(usageRows.map((usage) => [usage.runId, usage]));

      const segmentationReservationUsdMicros =
        env === undefined || (env.aiMode === "live" && env.samMode === "live") ? undefined : 0;
      const currentExecutionMode = env?.aiMode;

      const summaries: RunSummaryDto[] = orderedRuns.map((run) =>
        toRunSummary(
          run,
          usageByRunId.get(run.id),
          env?.imageReservationUsdMicros,
          segmentationReservationUsdMicros,
          currentExecutionMode,
        ),
      );

      return {
        comparisonGroupId,
        runs: summaries,
        sharedSelectionCost: sharedSelectionCost(tx as unknown as AppDatabase, orderedRuns),
        candidateCost: summarizeCandidateCost(orderedRuns, usageByRunId),
      };
    },
    { behavior: "deferred" },
  );
}

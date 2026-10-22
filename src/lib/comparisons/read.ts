import { asc, eq } from "drizzle-orm";

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

function accumulateRunCost(
  accumulator: CandidateCostAccumulator,
  run: RunRow,
  usage: UsageEventRow | undefined,
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
  groupRuns: RunRow[],
  usageByRunId: Map<string, UsageEventRow>,
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
  groupRuns: RunRow[],
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
  const groupRuns = db
    .select()
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

  const usageRows = db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.projectId, groupRuns[0]!.projectId))
    .all();
  const usageByRunId = new Map(usageRows.map((usage) => [usage.runId, usage]));

  const segmentationReservationUsdMicros =
    env === undefined || (env.aiMode === "live" && env.samMode === "live") ? undefined : 0;

  const summaries: RunSummaryDto[] = orderedRuns.map((run) =>
    toRunSummary(
      run,
      usageByRunId.get(run.id),
      env?.imageReservationUsdMicros,
      segmentationReservationUsdMicros,
    ),
  );

  return {
    comparisonGroupId,
    runs: summaries,
    sharedSelectionCost: sharedSelectionCost(db, orderedRuns),
    candidateCost: summarizeCandidateCost(orderedRuns, usageByRunId),
  };
}

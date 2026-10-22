import { asc, eq } from "drizzle-orm";

import type {
  CostBucketsDto,
  CostEventDto,
  ProjectCostsDto,
  ProjectCostTotalsDto,
} from "../contracts/api";
import type { AppDatabase } from "../db/client";
import {
  projects,
  runs,
  usageEvents,
  type RunRow,
  type UsageEventRow,
} from "../db/schema";
import { AppError } from "../errors";

const OPERATION_ORDER: Array<RunRow["kind"]> = ["generate", "segment", "edit"];

type CostRunRow = Pick<
  RunRow,
  "id" | "projectId" | "kind" | "model" | "status" | "budgetChargeUsdMicros"
>;

type CostUsageRow = Pick<
  UsageEventRow,
  | "id"
  | "runId"
  | "operation"
  | "provider"
  | "model"
  | "executionMode"
  | "outcome"
  | "amountUsdMicros"
  | "costProvenance"
  | "pricingVersion"
  | "providerRequestId"
  | "elapsedMs"
  | "createdAt"
  | "settledAt"
>;

export function emptyCostBuckets(): CostBucketsDto {
  return {
    providerUsdMicros: 0,
    calculatedUsdMicros: 0,
    estimatedUsdMicros: 0,
    activeReservationUsdMicros: 0,
    unknownHoldUsdMicros: 0,
  };
}

function bucketTotal(buckets: CostBucketsDto): number {
  return (
    buckets.providerUsdMicros +
    buckets.calculatedUsdMicros +
    buckets.estimatedUsdMicros +
    buckets.activeReservationUsdMicros +
    buckets.unknownHoldUsdMicros
  );
}

export function accumulateRunCost(
  buckets: CostBucketsDto,
  run: CostRunRow,
  usage: CostUsageRow | undefined,
): void {
  if (usage !== undefined && usage.settledAt !== null) {
    if (usage.amountUsdMicros !== null) {
      if (usage.costProvenance === "provider") {
        buckets.providerUsdMicros += usage.amountUsdMicros;
      } else if (usage.costProvenance === "calculated") {
        buckets.calculatedUsdMicros += usage.amountUsdMicros;
      } else if (usage.costProvenance === "estimated") {
        buckets.estimatedUsdMicros += usage.amountUsdMicros;
      } else {
        buckets.unknownHoldUsdMicros += usage.amountUsdMicros;
      }
    } else {
      buckets.unknownHoldUsdMicros += run.budgetChargeUsdMicros;
    }
    return;
  }

  if (run.status === "queued" || run.status === "running") {
    buckets.activeReservationUsdMicros += run.budgetChargeUsdMicros;
    return;
  }

  if (run.budgetChargeUsdMicros > 0) {
    buckets.unknownHoldUsdMicros += run.budgetChargeUsdMicros;
  }
}

function reconcileBuckets(buckets: CostBucketsDto, chargeSum: number): CostBucketsDto {
  const total = bucketTotal(buckets);
  if (chargeSum > total) {
    return { ...buckets, unknownHoldUsdMicros: buckets.unknownHoldUsdMicros + (chargeSum - total) };
  }
  return buckets;
}

function bucketsForRuns(
  groupRuns: CostRunRow[],
  usageByRunId: Map<string, CostUsageRow>,
): CostBucketsDto {
  const buckets = emptyCostBuckets();
  let chargeSum = 0;
  for (const run of groupRuns) {
    chargeSum += run.budgetChargeUsdMicros;
    accumulateRunCost(buckets, run, usageByRunId.get(run.id));
  }
  return reconcileBuckets(buckets, chargeSum);
}

function toCostEvent(usage: CostUsageRow): CostEventDto {
  return {
    id: usage.id,
    runId: usage.runId,
    operation: usage.operation,
    provider: usage.provider,
    model: usage.model,
    executionMode: usage.executionMode,
    outcome: usage.outcome,
    amountUsdMicros: usage.amountUsdMicros,
    costProvenance: usage.costProvenance,
    pricingVersion: usage.pricingVersion,
    providerRequestId: usage.providerRequestId,
    elapsedMs: usage.elapsedMs,
    createdAt: usage.createdAt,
    settledAt: usage.settledAt,
  };
}

export function getProjectCosts(db: AppDatabase, projectId: string): ProjectCostsDto {
  return db.transaction(
    (tx) => {
      const project = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project === undefined) {
        throw new AppError(404, "NOT_FOUND", "Project was not found.");
      }

      const runRows = tx
        .select({
          id: runs.id,
          projectId: runs.projectId,
          kind: runs.kind,
          model: runs.model,
          status: runs.status,
          budgetChargeUsdMicros: runs.budgetChargeUsdMicros,
        })
        .from(runs)
        .where(eq(runs.projectId, projectId))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all();
      const usageRows = tx
        .select({
          id: usageEvents.id,
          runId: usageEvents.runId,
          operation: usageEvents.operation,
          provider: usageEvents.provider,
          model: usageEvents.model,
          executionMode: usageEvents.executionMode,
          outcome: usageEvents.outcome,
          amountUsdMicros: usageEvents.amountUsdMicros,
          costProvenance: usageEvents.costProvenance,
          pricingVersion: usageEvents.pricingVersion,
          providerRequestId: usageEvents.providerRequestId,
          elapsedMs: usageEvents.elapsedMs,
          createdAt: usageEvents.createdAt,
          settledAt: usageEvents.settledAt,
        })
        .from(usageEvents)
        .where(eq(usageEvents.projectId, projectId))
        .orderBy(asc(usageEvents.createdAt), asc(usageEvents.id))
        .all();
      const usageByRunId = new Map(usageRows.map((usage) => [usage.runId, usage]));

      const totalsBuckets = bucketsForRuns(runRows, usageByRunId);
      const commitmentUsdMicros = bucketTotal(totalsBuckets);
      const totals: ProjectCostTotalsDto = {
        ...totalsBuckets,
        commitmentUsdMicros,
        budgetLimitUsdMicros: project.budgetLimitUsdMicros,
        remainingUsdMicros: Math.max(0, project.budgetLimitUsdMicros - commitmentUsdMicros),
        overrunUsdMicros: Math.max(0, commitmentUsdMicros - project.budgetLimitUsdMicros),
      };

      const operations = new Map<RunRow["kind"], CostRunRow[]>();
      const models = new Map<string, CostRunRow[]>();
      for (const run of runRows) {
        const operationRuns = operations.get(run.kind) ?? [];
        operationRuns.push(run);
        operations.set(run.kind, operationRuns);
        const modelRuns = models.get(run.model) ?? [];
        modelRuns.push(run);
        models.set(run.model, modelRuns);
      }

      const byOperation = OPERATION_ORDER.filter((operation) => operations.has(operation)).map(
        (operation) => ({
          operation,
          ...bucketsForRuns(operations.get(operation) ?? [], usageByRunId),
        }),
      );

      const byModel = [...models.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, modelRuns]) => ({
          model,
          ...bucketsForRuns(modelRuns, usageByRunId),
        }));

      return {
        totals,
        byOperation,
        byModel,
        events: usageRows.map(toCostEvent),
      };
    },
    { behavior: "deferred" },
  );
}

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import {
  COST_PROVENANCES,
  EXECUTION_MODES,
  RUN_KINDS,
  USAGE_OUTCOMES,
  usageEvents,
  type UsageEventRow,
} from "../db/schema";

type RunKind = (typeof RUN_KINDS)[number];
type ExecutionMode = (typeof EXECUTION_MODES)[number];
type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
type CostProvenance = (typeof COST_PROVENANCES)[number];

export function createPendingUsageEvent(
  db: AppDatabase,
  input: {
    projectId: string;
    runId: string;
    operation: RunKind;
    provider: string;
    model: string;
    executionMode: ExecutionMode;
    pricingVersion: string;
    pricingSourceSnapshot: Record<string, unknown>;
  },
): UsageEventRow {
  const row: UsageEventRow = {
    id: randomUUID(),
    projectId: input.projectId,
    runId: input.runId,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    executionMode: input.executionMode,
    outcome: "pending",
    amountUsdMicros: null,
    costProvenance: "unavailable",
    pricingVersion: input.pricingVersion,
    pricingSourceSnapshotJson: input.pricingSourceSnapshot,
    usageJson: null,
    providerRequestId: null,
    elapsedMs: null,
    createdAt: Date.now(),
    settledAt: null,
  };

  db.insert(usageEvents).values(row).run();
  return row;
}

export function settleUsageEvent(
  db: AppDatabase,
  input: {
    runId: string;
    outcome: Exclude<UsageOutcome, "pending">;
    amountUsdMicros: number | null;
    costProvenance: CostProvenance;
    usageJson?: Record<string, unknown> | null;
    providerRequestId?: string | null;
    elapsedMs?: number | null;
  },
): void {
  if (
    input.amountUsdMicros !== null &&
    (!Number.isSafeInteger(input.amountUsdMicros) || input.amountUsdMicros < 0)
  ) {
    throw new Error("Usage amount must be a nonnegative integer or null.");
  }

  db.update(usageEvents)
    .set({
      outcome: input.outcome,
      amountUsdMicros: input.amountUsdMicros,
      costProvenance: input.costProvenance,
      usageJson: input.usageJson ?? null,
      providerRequestId: input.providerRequestId ?? null,
      elapsedMs: input.elapsedMs ?? null,
      settledAt: Date.now(),
    })
    .where(eq(usageEvents.runId, input.runId))
    .run();
}

export function markUsageUnknown(db: AppDatabase, runId: string): void {
  const existing = getUsageEventByRunId(db, runId);
  if (existing === undefined || existing.settledAt !== null) return;

  settleUsageEvent(db, {
    runId,
    outcome: "unknown",
    amountUsdMicros: null,
    costProvenance: "unavailable",
  });
}

export function getUsageEventByRunId(db: AppDatabase, runId: string): UsageEventRow | undefined {
  return db.select().from(usageEvents).where(eq(usageEvents.runId, runId)).get();
}

import { and, asc, eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { runs, type RunRow } from "../db/schema";
import { getUsageEventByRunId, markUsageUnknown } from "../usage/service";
import { isCompleteReceipt } from "./receipt";

export function claimNextRun(db: AppDatabase): RunRow | null {
  return db.transaction(
    (tx) => {
      const next = tx
        .select()
        .from(runs)
        .where(eq(runs.status, "queued"))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(1)
        .get();

      if (next === undefined) return null;

      const now = Date.now();
      tx.update(runs)
        .set({
          status: "running",
          stage: "preparing",
          startedAt: now,
        })
        .where(and(eq(runs.id, next.id), eq(runs.status, "queued")))
        .run();

      return tx.select().from(runs).where(eq(runs.id, next.id)).get() ?? null;
    },
    { behavior: "immediate" },
  );
}

export function recoverRunningRuns(db: AppDatabase, assetDir?: string): number {
  const running = db.select().from(runs).where(eq(runs.status, "running")).all();
  let changed = 0;

  for (const run of running) {
    const now = Date.now();

    if (run.providerStartedAt === null) {
      db.update(runs)
        .set({
          status: "queued",
          stage: "queued",
          startedAt: null,
        })
        .where(eq(runs.id, run.id))
        .run();
      changed += 1;
      continue;
    }

    if (isCompleteReceipt(db, run.providerReceiptJson, assetDir)) {
      db.update(runs)
        .set({
          status: "queued",
          stage: "processing",
          startedAt: null,
        })
        .where(eq(runs.id, run.id))
        .run();
      changed += 1;
      continue;
    }

    const usage = getUsageEventByRunId(db, run.id);
    if (usage?.settledAt !== null && usage?.outcome === "completed") {
      db.update(runs)
        .set({
          status: "failed",
          stage: "error",
          finishedAt: now,
          errorCode: "LOCAL_PROCESSING_FAILED",
          errorMessage: "Provider output was lost before a reusable receipt could be saved.",
        })
        .where(eq(runs.id, run.id))
        .run();
      changed += 1;
      continue;
    }

    if (usage?.settledAt !== null && usage?.outcome === "rejected") {
      db.update(runs)
        .set({
          status: "failed",
          stage: "error",
          finishedAt: now,
          errorCode: "PROVIDER_REJECTED",
          errorMessage: "The provider rejected the request.",
        })
        .where(eq(runs.id, run.id))
        .run();
      changed += 1;
      continue;
    }

    if (usage !== undefined && usage.settledAt === null) {
      markUsageUnknown(db, run.id);
    }

    db.update(runs)
      .set({
        status: "needs_review",
        stage: "error",
        finishedAt: now,
        errorCode: "INTERRUPTED",
        errorMessage: "The provider invocation outcome is unknown. Retry requires explicit acknowledgment.",
      })
      .where(eq(runs.id, run.id))
      .run();
    changed += 1;
  }

  return changed;
}

export function markRunFailed(
  db: AppDatabase,
  run: RunRow,
  input: { code: string; message: string; preProvider: boolean },
): void {
  const current = db.select().from(runs).where(eq(runs.id, run.id)).get() ?? run;
  const releaseReservation = input.preProvider && current.providerStartedAt === null;
  db.update(runs)
    .set({
      status: "failed",
      stage: "error",
      finishedAt: Date.now(),
      errorCode: input.code,
      errorMessage: input.message,
      budgetChargeUsdMicros: releaseReservation ? 0 : current.budgetChargeUsdMicros,
    })
    .where(eq(runs.id, run.id))
    .run();
}

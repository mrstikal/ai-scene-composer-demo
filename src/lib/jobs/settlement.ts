import { eq } from "drizzle-orm";

import type { AppDatabase, DatabaseHandle } from "../db/client";
import { runs } from "../db/schema";
import { settleUsageEvent } from "../usage/service";
import { immediateTransaction } from "../db/transaction";

export interface RunSettlement {
  outcome: "completed" | "rejected";
  amountUsdMicros: number | null;
  costProvenance: "provider" | "calculated" | "estimated" | "unavailable";
  chargeUsdMicros: number | null;
  usageJson?: Record<string, unknown> | null;
  providerRequestId?: string | null;
  elapsedMs?: number | null;
}

export function settleRunAttempt(
  context: { db: AppDatabase; sqlite: DatabaseHandle["sqlite"] },
  runId: string,
  settlement: RunSettlement,
): void {
  const now = Date.now();
  immediateTransaction(context.sqlite, () => {
    settleUsageEvent(context.db, {
      runId,
      outcome: settlement.outcome,
      amountUsdMicros: settlement.amountUsdMicros,
      costProvenance: settlement.costProvenance,
      usageJson: settlement.usageJson,
      providerRequestId: settlement.providerRequestId,
      elapsedMs: settlement.elapsedMs,
    });

    context.db
      .update(runs)
      .set({
        providerFinishedAt: now,
        ...(settlement.chargeUsdMicros === null
          ? {}
          : { budgetChargeUsdMicros: settlement.chargeUsdMicros }),
      })
      .where(eq(runs.id, runId))
      .run();
  });
}

export function markRunNeedsReview(
  db: AppDatabase,
  runId: string,
  input: { message: string; code?: "INTERRUPTED" | "PROVIDER_TIMEOUT" },
): void {
  db.update(runs)
    .set({
      status: "needs_review",
      stage: "error",
      finishedAt: Date.now(),
      errorCode: input.code ?? "INTERRUPTED",
      errorMessage: input.message,
    })
    .where(eq(runs.id, runId))
    .run();
}

import { eq, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { projects, runs } from "../db/schema";
import { AppError } from "../errors";

export function getProjectCommitmentMicros(db: AppDatabase, projectId: string): number {
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${runs.budgetChargeUsdMicros}), 0)`,
    })
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .get();

  return Number(row?.total ?? 0);
}

export function assertReservationAllowed(
  db: AppDatabase,
  projectId: string,
  reservationUsdMicros: number,
): { commitmentUsdMicros: number; budgetLimitUsdMicros: number } {
  if (!Number.isSafeInteger(reservationUsdMicros) || reservationUsdMicros < 0) {
    throw new AppError(500, "CONFIG_INVALID", "Reservation must be a nonnegative integer.");
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (project === undefined) {
    throw new AppError(404, "NOT_FOUND", "Project was not found.");
  }

  const commitment = getProjectCommitmentMicros(db, projectId);
  if (commitment + reservationUsdMicros > project.budgetLimitUsdMicros) {
    throw new AppError(402, "BUDGET_EXCEEDED", "The project budget would be exceeded.");
  }

  return {
    commitmentUsdMicros: commitment,
    budgetLimitUsdMicros: project.budgetLimitUsdMicros,
  };
}

export function setRunBudgetCharge(
  db: AppDatabase,
  runId: string,
  amountUsdMicros: number | null,
): void {
  if (amountUsdMicros !== null && (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros < 0)) {
    throw new AppError(500, "CONFIG_INVALID", "Settled amount must be a nonnegative integer or null.");
  }

  if (amountUsdMicros === null) {
    return;
  }

  db.update(runs).set({ budgetChargeUsdMicros: amountUsdMicros }).where(eq(runs.id, runId)).run();
}

export function releasePreProviderReservation(db: AppDatabase, runId: string): void {
  db.update(runs).set({ budgetChargeUsdMicros: 0 }).where(eq(runs.id, runId)).run();
}

import { eq } from "drizzle-orm";

import type { Evaluation } from "../contracts/domain";
import { editSnapshotSchema } from "../contracts/domain";
import type { AppDatabase } from "../db/client";
import { runs } from "../db/schema";
import { AppError } from "../errors";
import { getRunOrThrow } from "../runs/retry";

export function saveRunEvaluation(
  db: AppDatabase,
  runId: string,
  evaluation: Evaluation,
): Evaluation {
  const run = getRunOrThrow(db, runId);
  if (run.kind !== "edit" || run.status !== "succeeded") {
    throw new AppError(422, "INVALID_RUN_STATE", "Evaluation requires a successful edit run.");
  }

  const snapshot = editSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!snapshot.success) {
    throw new AppError(422, "INVALID_RUN_STATE", "The edit input snapshot is invalid.");
  }
  if (snapshot.data.referenceAssetIds.length === 0 && evaluation.referenceFidelity !== null) {
    throw new AppError(
      400,
      "INVALID_REQUEST",
      "Reference fidelity must be null when the edit had no references.",
    );
  }

  db.update(runs).set({ evaluationJson: evaluation }).where(eq(runs.id, runId)).run();
  return evaluation;
}

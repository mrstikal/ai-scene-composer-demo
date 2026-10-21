import type { DatabaseHandle } from "./client";

export function immediateTransaction<T>(sqlite: DatabaseHandle["sqlite"], work: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

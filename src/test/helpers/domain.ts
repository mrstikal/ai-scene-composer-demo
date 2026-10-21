import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "@/lib/db/client";
import {
  assets,
  runs,
  type AssetRow,
  type RunRow,
} from "@/lib/db/schema";

export function insertRun(
  db: AppDatabase,
  projectId: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
): RunRow {
  const id = overrides.id ?? randomUUID();
  const now = Date.now();
  db.insert(runs)
    .values({
      id,
      projectId,
      kind: "generate",
      executionMode: "mock",
      model: "mock",
      inputSnapshotJson: {},
      status: "queued",
      stage: "queued",
      reservedUsdMicros: 0,
      budgetChargeUsdMicros: 0,
      createdAt: now,
      ...overrides,
    })
    .run();

  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (row === undefined) throw new Error("Inserted run was not found.");
  return row;
}

export function insertAssetRow(
  db: AppDatabase,
  projectId: string,
  overrides: Partial<typeof assets.$inferInsert> = {},
): AssetRow {
  const id = overrides.id ?? randomUUID();
  const now = Date.now();
  db.insert(assets)
    .values({
      id,
      projectId,
      kind: "raw",
      relativePath: `${projectId}/${id}.png`,
      sha256: "0".repeat(64),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      bytes: 1,
      createdAt: now,
      ...overrides,
    })
    .run();

  const row = db.select().from(assets).where(eq(assets.id, id)).get();
  if (row === undefined) throw new Error("Inserted asset was not found.");
  return row;
}

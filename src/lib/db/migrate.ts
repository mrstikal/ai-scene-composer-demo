import { readFileSync } from "node:fs";
import { join } from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { AppDatabase } from "./client";

const REQUIRED_TABLES = [
  "projects",
  "assets",
  "versions",
  "selections",
  "runs",
  "usage_events",
  "idempotency_keys",
] as const;

interface MigrationJournal {
  entries: unknown[];
}

function expectedMigrationCount(migrationsFolder: string): number | null {
  try {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as MigrationJournal;
    return Array.isArray(journal.entries) ? journal.entries.length : null;
  } catch {
    return null;
  }
}

export function migrateDatabase(
  db: AppDatabase,
  migrationsFolder = join(process.cwd(), "drizzle"),
): void {
  migrate(db, { migrationsFolder });
}

export function isDatabaseMigrated(
  sqlite: { prepare: (sql: string) => { get: () => unknown } },
  migrationsFolder = join(process.cwd(), "drizzle"),
): boolean {
  for (const table of REQUIRED_TABLES) {
    const row = sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = '${table}'`)
      .get();
    if (row === undefined) return false;
  }

  const expected = expectedMigrationCount(migrationsFolder);
  if (expected === null) return true;

  try {
    const row = sqlite
      .prepare("select count(*) as count from __drizzle_migrations")
      .get() as { count?: unknown } | undefined;
    return typeof row?.count === "number" && row.count >= expected;
  } catch {
    return false;
  }
}

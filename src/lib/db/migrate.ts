import { join } from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { AppDatabase } from "./client";

export function migrateDatabase(
  db: AppDatabase,
  migrationsFolder = join(process.cwd(), "drizzle"),
): void {
  migrate(db, { migrationsFolder });
}

export function isDatabaseMigrated(sqlite: { prepare: (sql: string) => { get: () => unknown } }): boolean {
  const row = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name = 'projects'")
    .get();
  return row !== undefined;
}

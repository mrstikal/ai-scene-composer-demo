import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { getEnv } from "../config/env";
import * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  path: string;
  sqlite: Database.Database;
  db: AppDatabase;
  close: () => void;
}

export function createDatabase(databasePath: string): DatabaseHandle {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (databasePath !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle(sqlite, { schema });
  return {
    path: databasePath,
    sqlite,
    db,
    close: () => {
      sqlite.close();
    },
  };
}

let singleton: DatabaseHandle | null = null;

export function getDatabase(): DatabaseHandle {
  if (singleton === null) {
    singleton = createDatabase(getEnv().databasePath);
  }
  return singleton;
}

export function resetDatabaseForTests(): void {
  if (singleton !== null) {
    singleton.close();
    singleton = null;
  }
}

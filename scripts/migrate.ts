import nextEnv from "@next/env";

import { getEnv } from "../src/lib/config/env";
import { createDatabase } from "../src/lib/db/client";
import { migrateDatabase } from "../src/lib/db/migrate";

nextEnv.loadEnvConfig(process.cwd());

try {
  const env = getEnv();
  const handle = createDatabase(env.databasePath);
  try {
    migrateDatabase(handle.db);
    process.stdout.write("Database migrated.\n");
  } finally {
    handle.close();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Database migration failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

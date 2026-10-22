import nextEnv from "@next/env";

import { getEnv } from "../lib/config/env";
import { createDatabase } from "../lib/db/client";
import { isDatabaseMigrated } from "../lib/db/migrate";
import { createProductionHandlers } from "../lib/jobs/handlers";
import { runWorkerLoop } from "../lib/jobs/worker";

async function main(): Promise<void> {
  nextEnv.loadEnvConfig(process.cwd());
  const env = getEnv();
  const handle = createDatabase(env.databasePath);

  if (!isDatabaseMigrated(handle.sqlite)) {
    handle.close();
    throw new Error("Database schema is not migrated. Run npm run db:migrate first.");
  }

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const handlers = createProductionHandlers();

  try {
    await runWorkerLoop({
      db: handle.db,
      sqlite: handle.sqlite,
      env,
      handlers,
      signal: controller.signal,
    });
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

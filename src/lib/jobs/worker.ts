import { setTimeout as sleep } from "node:timers/promises";

import * as lockfile from "proper-lockfile";

import type { AppEnv } from "../config/env";
import type { AppDatabase, DatabaseHandle } from "../db/client";
import type { RunRow } from "../db/schema";
import { AppError } from "../errors";
import { claimNextRun, markRunFailed, recoverRunningRuns } from "./queue";

export interface RunHandlerContext {
  db: AppDatabase;
  sqlite: DatabaseHandle["sqlite"];
  env: AppEnv;
}

export type RunHandler = (run: RunRow, context: RunHandlerContext) => Promise<void> | void;

export type HandlerRegistry = Partial<Record<RunRow["kind"], RunHandler>>;

export interface RunOnceResult {
  status: "idle" | "handled" | "failed";
  runId?: string;
  errorCode?: string;
}

export async function runOnce(input: {
  db: AppDatabase;
  sqlite: DatabaseHandle["sqlite"];
  env: AppEnv;
  handlers: HandlerRegistry;
}): Promise<RunOnceResult> {
  const run = claimNextRun(input.db);
  if (run === null) {
    return { status: "idle" };
  }

  const handler = input.handlers[run.kind];
  if (handler === undefined) {
    markRunFailed(input.db, run, {
      code: "HANDLER_UNAVAILABLE",
      message: "No domain handler is installed for this run kind yet.",
      preProvider: true,
    });
    return { status: "failed", runId: run.id, errorCode: "HANDLER_UNAVAILABLE" };
  }

  try {
    await handler(run, {
      db: input.db,
      sqlite: input.sqlite,
      env: input.env,
    });
    return { status: "handled", runId: run.id };
  } catch {
    markRunFailed(input.db, run, {
      code: "HANDLER_ERROR",
      message: "The run handler failed.",
      preProvider: run.providerStartedAt === null,
    });
    return { status: "failed", runId: run.id, errorCode: "HANDLER_ERROR" };
  }
}

export async function runWorkerLoop(input: {
  db: AppDatabase;
  sqlite: DatabaseHandle["sqlite"];
  env: AppEnv;
  handlers: HandlerRegistry;
  signal: AbortSignal;
}): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(input.env.databasePath, {
      retries: 0,
      update: 5000,
      stale: 120000,
      realpath: false,
    });
  } catch {
    throw new AppError(500, "CONFIG_INVALID", "Another worker holds the database lock.");
  }

  try {
    recoverRunningRuns(input.db);
    process.stdout.write("SCENE_WORKER_READY\n");

    while (!input.signal.aborted) {
      const result = await runOnce(input);
      if (result.status === "idle") {
        try {
          await sleep(500, undefined, { signal: input.signal });
        } catch {
          break;
        }
      }
    }
  } finally {
    await release();
  }
}

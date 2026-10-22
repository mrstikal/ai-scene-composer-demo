import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";

import { getEnv } from "../src/lib/config/env";
import { createDatabase } from "../src/lib/db/client";
import { migrateDatabase } from "../src/lib/db/migrate";

export function assertSafeTarget(repoRoot: string, target: string, label: string): void {
  const absolute = resolve(target);
  if (absolute === resolve(repoRoot) || absolute === resolve("/")) {
    throw new Error(`Refusing to delete ${label} at an unsafe root path.`);
  }

  const rel = relative(repoRoot, absolute);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Refusing to delete ${label} outside the repository.`);
  }

  const realRoot = realpathSync(repoRoot);
  let current = resolve(repoRoot);
  for (const component of rel.split(sep)) {
    current = resolve(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to delete ${label} through a symlinked path component.`);
    }
    const realComponent = realpathSync(current);
    const realRel = relative(realRoot, realComponent);
    if (realRel.startsWith("..") || realRel === "") {
      throw new Error(`Refusing to delete ${label} outside the repository.`);
    }
  }
}

export function assertInside(repoRoot: string, target: string, prefix: string, label: string): void {
  const rel = relative(repoRoot, resolve(target));
  if (!(rel === prefix || rel.startsWith(`${prefix}/`))) {
    throw new Error(`Refusing to delete ${label} outside the dedicated ${prefix} directory.`);
  }
}

function main(): void {
  if (process.env.RESET_LOCAL_DATA !== "1") {
    throw new Error("Set RESET_LOCAL_DATA=1 to confirm destructive local reset.");
  }

  nextEnv.loadEnvConfig(process.cwd());
  const env = getEnv();
  const repoRoot = process.cwd();

  assertSafeTarget(repoRoot, env.databasePath, "database");
  assertSafeTarget(repoRoot, env.assetDir, "asset directory");
  assertInside(repoRoot, env.databasePath, "data", "database");
  assertInside(repoRoot, env.assetDir, "assets-local", "asset directory");

  if (existsSync(`${env.databasePath}.lock`)) {
    throw new Error("A worker lock is present. Stop the worker before resetting local data.");
  }

  for (const path of [env.databasePath, `${env.databasePath}-wal`, `${env.databasePath}-shm`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  if (existsSync(env.assetDir)) rmSync(env.assetDir, { recursive: true, force: true });

  const handle = createDatabase(env.databasePath);
  try {
    migrateDatabase(handle.db);
  } finally {
    handle.close();
  }

  process.stdout.write("Local database and assets reset. Migrations applied.\n");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local data reset failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

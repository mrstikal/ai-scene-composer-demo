import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { AppError } from "../errors";

export type AiMode = "mock" | "live";
export type SamMode = "fixture" | "live";

export interface AppEnv {
  repoRoot: string;
  aiMode: AiMode;
  samMode: SamMode;
  runLiveAiTests: "0" | "1";
  openRouterApiKey: string | null;
  metaModelApiKey: string | null;
  databasePath: string;
  assetDir: string;
  projectBudgetUsdMicros: number;
  imageReservationUsdMicros: number;
}

function configError(message: string): AppError {
  return new AppError(500, "CONFIG_INVALID", message);
}

function parseEnum<T extends string>(value: string | undefined, fallback: T, field: string, allowed: readonly T[]): T {
  const resolved = value ?? fallback;
  if (!allowed.includes(resolved as T)) {
    throw configError(`Invalid ${field}. Expected ${allowed.join(" or ")}.`);
  }
  return resolved as T;
}

function parseMoneyToMicros(value: string | undefined, fallback: string, field: string, mode: "round" | "ceil"): number {
  const raw = (value ?? fallback).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw configError(`Invalid ${field}. Expected a positive USD amount.`);
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw configError(`Invalid ${field}. Expected a positive USD amount.`);
  }

  const micros = Math[mode](numeric * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw configError(`Invalid ${field}. Expected a positive USD amount.`);
  }
  return micros;
}

function parsePath(repoRoot: string, value: string | undefined, fallback: string, field: string): string {
  const raw = (value ?? fallback).trim();
  if (raw.length === 0) {
    throw configError(`Invalid ${field}. Expected a filesystem path.`);
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw);
}

export function parseEnv(
  env: Record<string, string | undefined> = process.env,
  repoRoot = process.cwd(),
): AppEnv {
  const aiMode = parseEnum(env.AI_MODE, "mock", "AI_MODE", ["mock", "live"] as const);
  const samMode = parseEnum(env.SAM_MODE, "fixture", "SAM_MODE", ["fixture", "live"] as const);
  const runLiveAiTests = parseEnum(env.RUN_LIVE_AI_TESTS, "0", "RUN_LIVE_AI_TESTS", ["0", "1"] as const);

  const databasePath = parsePath(repoRoot, env.DATABASE_PATH, "./data/scene-composer.sqlite", "DATABASE_PATH");
  const assetDir = parsePath(repoRoot, env.ASSET_DIR, "./assets-local", "ASSET_DIR");

  if (databasePath === assetDir) {
    throw configError("Invalid DATABASE_PATH and ASSET_DIR. They must be different paths.");
  }

  return {
    repoRoot,
    aiMode,
    samMode,
    runLiveAiTests,
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
    metaModelApiKey: env.META_MODEL_API_KEY?.trim() || null,
    databasePath,
    assetDir,
    projectBudgetUsdMicros: parseMoneyToMicros(env.PROJECT_BUDGET_USD, "5", "PROJECT_BUDGET_USD", "round"),
    imageReservationUsdMicros: parseMoneyToMicros(
      env.IMAGE_RESERVATION_USD,
      "0.25",
      "IMAGE_RESERVATION_USD",
      "ceil",
    ),
  };
}

export function getEnv(): AppEnv {
  return parseEnv(process.env, process.cwd());
}

export function databaseFileExists(env: AppEnv): boolean {
  return existsSync(env.databasePath);
}

import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { AppEnv } from "../config/env";
import {
  fixtureAssetsReady,
  tryReadFixtureManifest,
} from "../config/fixtures";
import { assertCompatibleConfig } from "../config/pricing";
import type { HealthResponse } from "../contracts/api";
import type { DatabaseHandle } from "../db/client";
import { isDatabaseMigrated } from "../db/migrate";
import { samFixtureStatus } from "../sam/capture";

const WORKER_READY_MAX_AGE_MS = 15_000;

async function getWorkerStatus(databasePath: string): Promise<HealthResponse["worker"]> {
  try {
    const lock = await stat(`${databasePath}.lock`);
    const age = Math.max(0, Date.now() - lock.mtimeMs);
    return {
      status: age <= WORKER_READY_MAX_AGE_MS ? "ready" : "stale",
      heartbeatAgeMs: age,
    };
  } catch {
    return { status: "missing", heartbeatAgeMs: null };
  }
}

export async function getHealth(
  handle: DatabaseHandle,
  env: AppEnv,
): Promise<{ status: number; body: HealthResponse }> {
  assertCompatibleConfig();

  let databaseReady = false;
  try {
    handle.sqlite.prepare("select 1").get();
    databaseReady = isDatabaseMigrated(handle.sqlite);
  } catch {
    databaseReady = false;
  }

  const manifest = tryReadFixtureManifest(env.repoRoot);
  const assetsReady =
    manifest !== null && fixtureAssetsReady(manifest, join(env.repoRoot, "src/test/fixtures"));
  const sample = manifest?.fixtures.find((fixture) => fixture.fixtureId === "living-room-v1") ?? null;
  const sampleProvenance = sample?.provenance ?? null;
  const licensedPhotosReady =
    manifest !== null &&
    manifest.licensedPhotosReady &&
    manifest.fixtures.every(
      (fixture) => fixture.provenance === "licensed_photo" && fixture.licenseRecord !== null,
    );
  const samStatus = samFixtureStatus(env.repoRoot, sample?.normalizedSha256);
  const capturedSamReady = samStatus.ready;

  const imagesAvailable = env.aiMode === "mock" || env.openRouterApiKey !== null;
  const segmentationAvailable =
    env.aiMode === "mock" ||
    (env.samMode === "fixture" ? capturedSamReady : env.metaModelApiKey !== null);

  const body: HealthResponse = {
    status: databaseReady && assetsReady ? "ready" : "not_ready",
    modes: {
      ai: env.aiMode,
      sam: env.samMode,
    },
    databaseReady,
    worker: await getWorkerStatus(env.databasePath),
    providers: {
      images: {
        available: imagesAvailable,
        reason: imagesAvailable ? null : "missing_key",
      },
      segmentation: {
        available: segmentationAvailable,
        reason:
          segmentationAvailable
            ? null
            : env.aiMode === "mock"
              ? null
              : env.samMode === "fixture"
                ? "fixture_missing"
                : "missing_key",
      },
    },
    fixtures: {
      sampleProvenance,
      licensedPhotosReady,
      samFixtureReady: capturedSamReady,
    },
  };

  return {
    status: body.status === "ready" ? 200 : 503,
    body,
  };
}

export function notReadyHealth(): HealthResponse {
  return {
    status: "not_ready",
    modes: { ai: "mock", sam: "fixture" },
    databaseReady: false,
    worker: { status: "missing", heartbeatAgeMs: null },
    providers: {
      images: { available: false, reason: "config_invalid" },
      segmentation: { available: false, reason: "config_invalid" },
    },
    fixtures: {
      sampleProvenance: null,
      licensedPhotosReady: false,
      samFixtureReady: false,
    },
  };
}

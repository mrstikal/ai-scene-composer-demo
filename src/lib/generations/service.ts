import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { sha256Hex } from "../assets/store";
import type { AppEnv } from "../config/env";
import { assertCompatibleConfig, getPricingConfig, getProviderCapabilities } from "../config/pricing";
import { getScenePreset, SCENE_PRESET_VERSION, type ScenePresetId } from "../../config/scene-presets";
import type { CostConsent, GenerationInput, GenerationResponse } from "../contracts/api";
import {
  generationSnapshotSchema,
  type GenerationSnapshot,
  type GenerationTransportOptions,
} from "../contracts/domain";
import type { DatabaseHandle } from "../db/client";
import { projects, runs, versions } from "../db/schema";
import { immediateTransaction } from "../db/transaction";
import { AppError } from "../errors";
import {
  findIdempotency,
  hashRequest,
  insertIdempotency,
  isUniqueConstraintError,
  replayIdempotent,
  type StoredIdempotentResponse,
} from "../idempotency/service";
import { assertProjectCanCreateRoot } from "../projects/service";
import { assertReservationAllowed } from "../budget/service";

export const GENERATION_TRANSPORT_OPTIONS: GenerationTransportOptions = {
  aspectRatio: "1:1",
  quality: "medium",
  background: "opaque",
  n: 1,
  provider: {
    only: ["openai"],
    allowFallbacks: false,
  },
  timeoutMs: 300_000,
};

export function resolveGenerationPrompt(input: GenerationInput): {
  mode: "preset" | "custom";
  presetId: ScenePresetId | null;
  presetVersion: "v1" | null;
  prompt: string;
} {
  if (input.mode === "preset") {
    const preset = getScenePreset(input.presetId);
    if (preset === undefined) {
      throw new AppError(400, "INVALID_REQUEST", "Unknown scene preset.");
    }
    return {
      mode: "preset",
      presetId: preset.id,
      presetVersion: SCENE_PRESET_VERSION,
      prompt: preset.prompt,
    };
  }

  const prompt = input.prompt.trim();
  if (prompt.length < 1 || prompt.length > 2000) {
    throw new AppError(400, "INVALID_REQUEST", "Custom prompt must contain 1-2000 characters.");
  }
  return {
    mode: "custom",
    presetId: null,
    presetVersion: null,
    prompt,
  };
}

export function buildGenerationSnapshot(input: {
  env: AppEnv;
  resolved: ReturnType<typeof resolveGenerationPrompt>;
  reservationUsdMicros: number;
}): GenerationSnapshot {
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();
  const promptSha256 = sha256Hex(Buffer.from(input.resolved.prompt, "utf8"));

  return generationSnapshotSchema.parse({
    operation: "generate",
    mode: input.resolved.mode,
    presetId: input.resolved.presetId,
    presetVersion: input.resolved.presetVersion,
    prompt: input.resolved.prompt,
    promptSha256,
    model: "openai/gpt-image-2.5-flare",
    executionMode: input.env.aiMode,
    transportOptions: GENERATION_TRANSPORT_OPTIONS,
    pricingVersion: pricing.version,
    capabilityVersion: capabilities.version,
    reservationUsdMicros: input.reservationUsdMicros,
  });
}

function validateConsent(consent: CostConsent, pricingVersion: string, reservationUsdMicros: number): void {
  if (consent.pricingVersion !== pricingVersion) {
    throw new AppError(409, "PRICING_CHANGED", "The pricing version changed. Refresh the project and retry.");
  }
  if (consent.reservationUsdMicros !== reservationUsdMicros) {
    throw new AppError(409, "PRICING_CHANGED", "The reservation changed. Refresh the project and retry.");
  }
}

function activeGenerationRun(db: DatabaseHandle["db"], projectId: string): boolean {
  return (
    db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, "generate"),
          inArray(runs.status, ["queued", "running"]),
        ),
      )
      .get() !== undefined
  );
}

export async function enqueueGeneration(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  generationInput: GenerationInput;
  costConsent: CostConsent;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, generationInput, costConsent, idempotencyKey } = input;
  const { db, sqlite } = handle;
  const resolved = resolveGenerationPrompt(generationInput);
  const operation = "generate";
  const requestHash = hashRequest({
    operation,
    projectId,
    mode: resolved.mode,
    presetId: resolved.presetId,
    presetVersion: resolved.presetVersion,
    prompt: resolved.prompt,
  });

  const replay = replayIdempotent(findIdempotency(db, projectId, idempotencyKey), operation, requestHash);
  if (replay !== null) return replay;

  assertCompatibleConfig();
  const pricing = getPricingConfig();
  const reservationUsdMicros = env.aiMode === "mock" ? 0 : env.imageReservationUsdMicros;
  validateConsent(costConsent, pricing.version, reservationUsdMicros);

  if (env.aiMode === "live" && env.openRouterApiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "OpenRouter is not configured.");
  }

  const snapshot = buildGenerationSnapshot({
    env,
    resolved,
    reservationUsdMicros,
  });

  const runId = randomUUID();
  const response: StoredIdempotentResponse = {
    status: 202,
    body: { runId } satisfies GenerationResponse,
  };
  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        operation,
        requestHash,
      );
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      assertProjectCanCreateRoot(db, projectId);
      assertReservationAllowed(db, projectId, reservationUsdMicros);

      db.insert(runs)
        .values({
          id: runId,
          projectId,
          kind: "generate",
          executionMode: env.aiMode,
          comparisonGroupId: null,
          retryOfRunId: null,
          parentVersionId: null,
          inputSelectionId: null,
          model: snapshot.model,
          inputSnapshotJson: snapshot,
          commonInputHash: snapshot.promptSha256,
          status: "queued",
          stage: "queued",
          reservedUsdMicros: reservationUsdMicros,
          budgetChargeUsdMicros: reservationUsdMicros,
          createdAt: Date.now(),
        })
        .run();

      insertIdempotency(db, {
        projectId,
        key: idempotencyKey,
        operation,
        requestHash,
        response,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const afterConstraint = replayIdempotent(
        findIdempotency(db, projectId, idempotencyKey),
        operation,
        requestHash,
      );
      if (afterConstraint !== null) return afterConstraint;

      if (activeGenerationRun(db, projectId)) {
        throw new AppError(409, "PROJECT_INITIALIZING", "The project is already initializing a root scene.");
      }

      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project?.rootVersionId !== null && project?.rootVersionId !== undefined) {
        throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
      }

      const root = db
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.projectId, projectId), isNull(versions.parentVersionId)))
        .get();
      if (root !== undefined) {
        throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
      }
    }
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

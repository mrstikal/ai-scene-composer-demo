import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { sha256Hex } from "../assets/store";
import type { AppEnv } from "../config/env";
import {
  assertCompatibleConfig,
  getPricingConfig,
  getProviderCapabilities,
  getSegmentationCalculatedCostUsdMicros,
} from "../config/pricing";
import type { CostConsent, SegmentationResponse } from "../contracts/api";
import {
  SAM_MODEL,
  SAM_PARSER_VERSION,
  SAM_PROMPT_VERSION,
  segmentSnapshotSchema,
  type Point,
  type SegmentSnapshot,
} from "../contracts/domain";
import type { DatabaseHandle } from "../db/client";
import { assets, runs, versions, type AssetRow, type VersionRow } from "../db/schema";
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
import { assertReservationAllowed } from "../budget/service";
import { buildSamPrompt } from "../providers/sam";
import { getProjectOrThrow } from "../projects/service";
import { loadSamCapture } from "../sam/capture";

export type SegmentationExecutionMode = "live" | "mock" | "fixture";

export function segmentationExecutionMode(env: AppEnv): SegmentationExecutionMode {
  return env.aiMode === "mock" ? "mock" : env.samMode;
}

export function segmentationReservationUsdMicros(env: AppEnv): number {
  return segmentationExecutionMode(env) === "live"
    ? getPricingConfig().reservations.segmentation.usdMicros
    : 0;
}

export function segmentationCalculatedCostUsdMicros(env: AppEnv): number {
  return segmentationExecutionMode(env) === "live"
    ? getSegmentationCalculatedCostUsdMicros()
    : 0;
}

export function validateSegmentationPoints(input: {
  positivePoints: readonly Point[];
  negativePoints: readonly Point[];
}): { positive: Point; negative: Point | null } {
  if (input.positivePoints.length !== 1) {
    throw new AppError(400, "INVALID_POINT", "Exactly one positive point is required.");
  }
  if (input.negativePoints.length > 1) {
    throw new AppError(400, "INVALID_POINT", "At most one negative point is allowed.");
  }

  const positive = input.positivePoints[0];
  if (positive === undefined) {
    throw new AppError(400, "INVALID_POINT", "A positive point is required.");
  }
  const negative = input.negativePoints[0] ?? null;

  for (const point of [positive, ...(negative === null ? [] : [negative])]) {
    if (
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= 1024 ||
      point.y >= 1024
    ) {
      throw new AppError(400, "INVALID_POINT", "Points must be integer pixels inside the canonical image.");
    }
  }

  if (negative !== null && negative.x === positive.x && negative.y === positive.y) {
    throw new AppError(400, "INVALID_POINT", "Positive and negative points must differ.");
  }
  return { positive, negative };
}

function getSourceVersion(input: {
  db: DatabaseHandle["db"];
  projectId: string;
  sourceVersionId: string;
}): { version: VersionRow; asset: AssetRow } {
  const version = input.db
    .select()
    .from(versions)
    .where(and(eq(versions.id, input.sourceVersionId), eq(versions.projectId, input.projectId)))
    .get();
  if (version === undefined) {
    throw new AppError(404, "NOT_FOUND", "Source version was not found in this project.");
  }

  const asset = input.db.select().from(assets).where(eq(assets.id, version.imageAssetId)).get();
  if (asset === undefined) {
    throw new AppError(500, "CONFIG_INVALID", "Source version image asset is missing.");
  }
  if (asset.width !== 1024 || asset.height !== 1024 || asset.mimeType !== "image/png") {
    throw new AppError(422, "INVALID_RUN_STATE", "SAM selection requires a 1024 x 1024 PNG source.");
  }

  return { version, asset };
}

function buildSegmentSnapshot(input: {
  env: AppEnv;
  source: { version: VersionRow; asset: AssetRow };
  positive: Point;
  negative: Point | null;
  reservationUsdMicros: number;
  capture: SegmentSnapshot["capture"];
}): SegmentSnapshot {
  const pricing = getPricingConfig();
  const capabilities = getProviderCapabilities();
  const prompt = buildSamPrompt({
    width: input.source.asset.width,
    height: input.source.asset.height,
    positive: input.positive,
    negative: input.negative,
  });

  return segmentSnapshotSchema.parse({
    operation: "segment",
    sourceVersionId: input.source.version.id,
    sourceAssetId: input.source.asset.id,
    sourceSha256: input.source.asset.sha256,
    width: input.source.asset.width,
    height: input.source.asset.height,
    positivePoints: [input.positive],
    negativePoints: input.negative === null ? [] : [input.negative],
    prompt,
    promptSha256: sha256Hex(Buffer.from(prompt, "utf8")),
    promptVersion: SAM_PROMPT_VERSION,
    model: SAM_MODEL,
    executionMode: segmentationExecutionMode(input.env),
    parserVersion: SAM_PARSER_VERSION,
    normalizationVersion: "normalization-v1",
    pricingVersion: pricing.version,
    capabilityVersion: capabilities.version,
    reservationUsdMicros: input.reservationUsdMicros,
    calculatedCostUsdMicros: segmentationCalculatedCostUsdMicros(input.env),
    capture: input.capture,
  });
}

function validateConsent(
  consent: CostConsent,
  pricingVersion: string,
  reservationUsdMicros: number,
): void {
  if (consent.pricingVersion !== pricingVersion) {
    throw new AppError(409, "PRICING_CHANGED", "The pricing version changed. Refresh the project and retry.");
  }
  if (consent.reservationUsdMicros !== reservationUsdMicros) {
    throw new AppError(409, "PRICING_CHANGED", "The reservation changed. Refresh the project and retry.");
  }
}

export async function enqueueSegmentation(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  sourceVersionId: string;
  positivePoints: Point[];
  negativePoints: Point[];
  costConsent: CostConsent;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, sourceVersionId, positivePoints, negativePoints, costConsent, idempotencyKey } =
    input;
  const { db, sqlite } = handle;
  const points = validateSegmentationPoints({ positivePoints, negativePoints });
  const operation = "segment";
  const requestHash = hashRequest({
    operation,
    projectId,
    sourceVersionId,
    positivePoints: [points.positive],
    negativePoints: points.negative === null ? [] : [points.negative],
    costConsent,
  });
  const replay = replayIdempotent(findIdempotency(db, projectId, idempotencyKey), operation, requestHash);
  if (replay !== null) return replay;

  assertCompatibleConfig();
  const pricing = getPricingConfig();
  const executionMode = segmentationExecutionMode(env);
  const reservationUsdMicros = segmentationReservationUsdMicros(env);
  validateConsent(costConsent, pricing.version, reservationUsdMicros);
  getProjectOrThrow(db, projectId);
  const source = getSourceVersion({ db, projectId, sourceVersionId });

  if (executionMode === "live" && env.metaModelApiKey === null) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "Meta SAM is not configured.");
  }

  let capture: SegmentSnapshot["capture"] = null;
  if (executionMode === "fixture") {
    const lookup = loadSamCapture({
      repoRoot: env.repoRoot,
      sourceSha256: source.asset.sha256,
      width: source.asset.width,
      height: source.asset.height,
      positivePoints,
      negativePoints,
    });
    if (lookup.status === "missing") {
      throw new AppError(
        503,
        "PROVIDER_UNAVAILABLE",
        "No authentic SAM capture matches this source and points. Enable live SAM or supply a capture.",
      );
    }
    if (lookup.status === "invalid") {
      throw new AppError(503, "PROVIDER_UNAVAILABLE", `SAM capture is unusable: ${lookup.reason}`);
    }
    capture = { relativePath: lookup.relativePath, sha256: lookup.sha256 };
  }

  const snapshot = buildSegmentSnapshot({
    env,
    source,
    positive: points.positive,
    negative: points.negative,
    reservationUsdMicros,
    capture,
  });

  const runId = randomUUID();
  const response: StoredIdempotentResponse = {
    status: 202,
    body: { runId } satisfies SegmentationResponse,
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

      getProjectOrThrow(db, projectId);
      getSourceVersion({ db, projectId, sourceVersionId });
      assertReservationAllowed(db, projectId, reservationUsdMicros);

      db.insert(runs)
        .values({
          id: runId,
          projectId,
          kind: "segment",
          executionMode,
          comparisonGroupId: null,
          retryOfRunId: null,
          parentVersionId: sourceVersionId,
          inputSelectionId: null,
          model: SAM_MODEL,
          inputSnapshotJson: snapshot,
          commonInputHash: null,
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
    }
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

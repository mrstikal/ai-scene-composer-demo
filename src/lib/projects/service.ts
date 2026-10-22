import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { sha256Hex, writeAssetBytes } from "../assets/store";
import type { AppEnv } from "../config/env";
import {
  fixturesRoot,
  getFixture,
  readFixtureManifest,
  resolveFixtureRelativePath,
} from "../config/fixtures";
import { getPublicPricing } from "../config/pricing";
import type {
  AssetUploadResponse,
  ProjectDto,
  ProjectListDto,
  ProjectSnapshotDto,
  RunSummaryDto,
  SampleImportResponse,
  SelectionDto,
  VersionDto,
} from "../contracts/api";
import type { SourceMetadata } from "../contracts/domain";
import type { AppDatabase, DatabaseHandle } from "../db/client";
import {
  assets,
  projects,
  runs,
  selections,
  usageEvents,
  versions,
  type AssetRow,
  type ProjectRow,
  type RunRow,
  type SelectionRow,
  type VersionRow,
} from "../db/schema";
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
import { inspectImage, normalizeBase, normalizeReference } from "../images/normalize";
import {
  classifyRetryMode,
  editInputFor,
  editMetricsFor,
  evaluationFor,
  hasPossibleDuplicateCharge,
  inputSummaryFor,
  retryReservationUsdMicros,
  segmentInputFor,
  type RunSummarySource,
  type UsageSummarySource,
} from "../runs/retry-mode";
import type { AssetRole } from "../contracts/api";

export function createProject(db: AppDatabase, env: AppEnv, title?: string): ProjectRow {
  const id = randomUUID();
  const now = Date.now();
  const resolvedTitle = (title ?? "Untitled Scene").trim();
  if (resolvedTitle.length === 0 || resolvedTitle.length > 120) {
    throw new AppError(400, "INVALID_REQUEST", "Project title must contain 1-120 characters.");
  }

  db.insert(projects)
    .values({
      id,
      title: resolvedTitle,
      rootVersionId: null,
      activeVersionId: null,
      budgetLimitUsdMicros: env.projectBudgetUsdMicros,
      createdAt: now,
    })
    .run();

  return {
    id,
    title: resolvedTitle,
    rootVersionId: null,
    activeVersionId: null,
    budgetLimitUsdMicros: env.projectBudgetUsdMicros,
    createdAt: now,
  };
}

export function listProjects(db: AppDatabase): ProjectListDto {
  const rows = db
    .select()
    .from(projects)
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .all();

  return {
    projects: rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
    })),
  };
}

export function getProjectOrThrow(db: AppDatabase, projectId: string): ProjectRow {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (project === undefined) {
    throw new AppError(404, "NOT_FOUND", "Project was not found.");
  }
  return project;
}

function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    title: row.title,
    rootVersionId: row.rootVersionId,
    activeVersionId: row.activeVersionId,
    budgetLimitUsdMicros: row.budgetLimitUsdMicros,
    createdAt: row.createdAt,
  };
}

function toVersionDto(row: VersionRow): VersionDto {
  return {
    id: row.id,
    parentVersionId: row.parentVersionId,
    imageAssetId: row.imageAssetId,
    origin: row.origin,
    originalAssetId: row.originalAssetId,
    originatingRunId: row.originatingRunId,
    sourceMetadata: row.sourceMetadataJson,
    createdAt: row.createdAt,
  };
}

function toSelectionDto(row: SelectionRow): SelectionDto {
  return {
    id: row.id,
    sourceVersionId: row.sourceVersionId,
    positivePoints: row.positivePointsJson,
    negativePoints: row.negativePointsJson,
    binaryMaskAssetId: row.binaryMaskAssetId,
    regions: row.regionsJson,
    createdAt: row.createdAt,
  };
}

export function toRunSummary(
  row: RunSummarySource,
  usage?: UsageSummarySource,
  imageReservationUsdMicros?: number,
  segmentationReservationUsdMicros?: number,
  currentExecutionMode?: RunRow["executionMode"],
): RunSummaryDto {
  const retryMode = classifyRetryMode(row, usage);
  return {
    id: row.id,
    kind: row.kind,
    executionMode: row.executionMode,
    model: row.model,
    status: row.status,
    stage: row.stage,
    parentVersionId: row.parentVersionId,
    outputVersionId: row.outputVersionId,
    outputSelectionId: row.outputSelectionId,
    rawAssetId: row.rawAssetId,
    normalizedRawAssetId: row.normalizedRawAssetId,
    comparisonGroupId: row.comparisonGroupId,
    retryOfRunId: row.retryOfRunId,
    commonInputHash: row.commonInputHash,
    inputSummary: inputSummaryFor(row),
    segmentInput: segmentInputFor(row),
    editInput: editInputFor(row),
    metrics: editMetricsFor(row),
    evaluation: evaluationFor(row),
    retryMode,
    retryReservationUsdMicros: retryReservationUsdMicros(
      row,
      retryMode,
      imageReservationUsdMicros,
      segmentationReservationUsdMicros,
      currentExecutionMode,
    ),
    possibleDuplicateCharge: hasPossibleDuplicateCharge(row, usage),
    providerLatencyMs: usage?.elapsedMs ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cost: {
      reservedUsdMicros: row.reservedUsdMicros,
      budgetChargeUsdMicros: row.budgetChargeUsdMicros,
      amountUsdMicros: usage?.amountUsdMicros ?? null,
      provenance: usage?.costProvenance ?? null,
      outcome: usage?.outcome ?? null,
    },
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function segmentationReservationQuoteUsdMicros(
  env?: Pick<AppEnv, "aiMode" | "samMode">,
): number | undefined {
  return env === undefined || (env.aiMode === "live" && env.samMode === "live") ? undefined : 0;
}

export function getProjectSnapshot(
  db: AppDatabase,
  projectId: string,
  env?: Pick<AppEnv, "imageReservationUsdMicros" | "aiMode" | "samMode">,
): ProjectSnapshotDto {
  const segmentationReservationUsdMicros = segmentationReservationQuoteUsdMicros(env);

  return db.transaction(
    (tx) => {
      const project = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (project === undefined) {
        throw new AppError(404, "NOT_FOUND", "Project was not found.");
      }

      const versionRows = tx
        .select()
        .from(versions)
        .where(eq(versions.projectId, projectId))
        .orderBy(asc(versions.createdAt), asc(versions.id))
        .all();
      const selectionRows = tx
        .select()
        .from(selections)
        .where(eq(selections.projectId, projectId))
        .orderBy(asc(selections.createdAt), asc(selections.id))
        .all();
      const runRows = tx
        .select({
          id: runs.id,
          projectId: runs.projectId,
          kind: runs.kind,
          executionMode: runs.executionMode,
          comparisonGroupId: runs.comparisonGroupId,
          retryOfRunId: runs.retryOfRunId,
          parentVersionId: runs.parentVersionId,
          inputSelectionId: runs.inputSelectionId,
          model: runs.model,
          inputSnapshotJson: runs.inputSnapshotJson,
          commonInputHash: runs.commonInputHash,
          status: runs.status,
          stage: runs.stage,
          reservedUsdMicros: runs.reservedUsdMicros,
          budgetChargeUsdMicros: runs.budgetChargeUsdMicros,
          rawAssetId: runs.rawAssetId,
          normalizedRawAssetId: runs.normalizedRawAssetId,
          outputSelectionId: runs.outputSelectionId,
          outputVersionId: runs.outputVersionId,
          metricsJson: runs.metricsJson,
          evaluationJson: runs.evaluationJson,
          createdAt: runs.createdAt,
          startedAt: runs.startedAt,
          providerStartedAt: runs.providerStartedAt,
          providerFinishedAt: runs.providerFinishedAt,
          finishedAt: runs.finishedAt,
          errorCode: runs.errorCode,
          errorMessage: runs.errorMessage,
          providerReceiptKind: sql<"image" | "segment" | null>`json_extract(${runs.providerReceiptJson}, '$.kind')`,
        })
        .from(runs)
        .where(eq(runs.projectId, projectId))
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .all();
      const usageRows = tx
        .select({
          runId: usageEvents.runId,
          outcome: usageEvents.outcome,
          amountUsdMicros: usageEvents.amountUsdMicros,
          costProvenance: usageEvents.costProvenance,
          elapsedMs: usageEvents.elapsedMs,
          settledAt: usageEvents.settledAt,
        })
        .from(usageEvents)
        .where(eq(usageEvents.projectId, projectId))
        .all();
      const usageByRunId = new Map(usageRows.map((usage) => [usage.runId, usage]));
      const referenceRows = tx
        .select()
        .from(assets)
        .where(and(eq(assets.projectId, projectId), eq(assets.kind, "reference")))
        .orderBy(asc(assets.createdAt), asc(assets.id))
        .all();

      function currentExecutionModeFor(
        kind: RunSummarySource["kind"],
      ): RunSummarySource["executionMode"] | undefined {
        if (env === undefined) return undefined;
        if (kind === "segment") return env.aiMode === "mock" ? "mock" : env.samMode;
        return env.aiMode;
      }

      return {
        project: toProjectDto(project),
        versions: versionRows.map(toVersionDto),
        selections: selectionRows.map(toSelectionDto),
        references: referenceRows.map((row) => ({
          id: row.id,
          width: row.width,
          height: row.height,
          sha256: row.sha256,
          createdAt: row.createdAt,
        })),
        runs: runRows.map((row) =>
          toRunSummary(
            row,
            usageByRunId.get(row.id),
            env?.imageReservationUsdMicros,
            segmentationReservationUsdMicros,
            currentExecutionModeFor(row.kind),
          ),
        ),
        pricing: getPublicPricing({
          imageReservationUsdMicros: env?.imageReservationUsdMicros,
          segmentationReservationUsdMicros,
        }),
      };
    },
    { behavior: "deferred" },
  );
}

export function setActiveVersion(
  db: AppDatabase,
  projectId: string,
  versionId: string,
): string {
  getProjectOrThrow(db, projectId);
  const version = db
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.projectId, projectId)))
    .get();
  if (version === undefined) {
    throw new AppError(404, "NOT_FOUND", "Version was not found in this project.");
  }

  db.update(projects).set({ activeVersionId: versionId }).where(eq(projects.id, projectId)).run();
  return versionId;
}

export function assertProjectCanCreateRoot(db: AppDatabase, projectId: string): ProjectRow {
  const project = getProjectOrThrow(db, projectId);
  if (project.rootVersionId !== null) {
    throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
  }

  const existingRoot = db
    .select({ id: versions.id })
    .from(versions)
    .where(and(eq(versions.projectId, projectId), isNull(versions.parentVersionId)))
    .get();
  if (existingRoot !== undefined) {
    throw new AppError(409, "ROOT_ALREADY_EXISTS", "This project already has a root scene.");
  }

  const initializing = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, "generate"),
        inArray(runs.status, ["queued", "running"]),
      ),
    )
    .get();
  if (initializing !== undefined) {
    throw new AppError(409, "PROJECT_INITIALIZING", "The project is already initializing a root scene.");
  }

  return project;
}

function replayOrNull(
  db: AppDatabase,
  projectId: string,
  key: string,
  operation: string,
  requestHash: string,
): StoredIdempotentResponse | null {
  return replayIdempotent(findIdempotency(db, projectId, key), operation, requestHash);
}

function handleImportConstraint(
  db: AppDatabase,
  projectId: string,
  key: string,
  operation: string,
  requestHash: string,
  requiresEmptyProject: boolean,
  error: unknown,
): StoredIdempotentResponse | null {
  if (!isUniqueConstraintError(error)) return null;

  const replay = replayOrNull(db, projectId, key, operation, requestHash);
  if (replay !== null) return replay;

  if (requiresEmptyProject) {
    assertProjectCanCreateRoot(db, projectId);
  }
  return null;
}

export async function importSample(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  sampleId: "living-room-v1";
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, sampleId, idempotencyKey } = input;
  const { db, sqlite } = handle;

  getProjectOrThrow(db, projectId);

  const operation = "sample_import";
  const requestHash = hashRequest({ operation, projectId, sampleId });
  const replay = replayOrNull(db, projectId, idempotencyKey, operation, requestHash);
  if (replay !== null) return replay;

  const manifest = readFixtureManifest(env.repoRoot);
  const fixture = getFixture(manifest, sampleId);
  const fixtureRoot = fixturesRoot(env.repoRoot);
  const sourceBytes = await readFile(resolveFixtureRelativePath(fixtureRoot, fixture.selectedPath));
  if (sha256Hex(sourceBytes) !== fixture.originalSha256) {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", "Fixture source hash does not match the manifest.");
  }

  const originalInfo = await inspectImage(sourceBytes);
  const canonical = await normalizeBase(sourceBytes, originalInfo);
  if (canonical.sha256 !== fixture.normalizedSha256) {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", "Fixture normalization hash does not match the manifest.");
  }

  const originalAssetId = randomUUID();
  const canonicalAssetId = randomUUID();
  const versionId = randomUUID();
  const now = Date.now();

  const originalWrite = await writeAssetBytes({
    assetDir: env.assetDir,
    projectId,
    assetId: originalAssetId,
    mimeType: originalInfo.mimeType,
    bytes: sourceBytes,
  });
  const canonicalWrite = await writeAssetBytes({
    assetDir: env.assetDir,
    projectId,
    assetId: canonicalAssetId,
    mimeType: "image/png",
    bytes: canonical.bytes,
  });

  const sourceMetadata: SourceMetadata = {
    fixtureId: fixture.fixtureId,
    provenance: fixture.provenance,
    originalSha256: fixture.originalSha256,
    normalizedSha256: fixture.normalizedSha256,
    normalizationVersion: fixture.normalizationVersion,
    licenseRecord: fixture.licenseRecord,
    ...(fixture.generator === undefined ? {} : { generator: fixture.generator }),
    ...(fixture.generatorVersion === undefined ? {} : { generatorVersion: fixture.generatorVersion }),
  };

  const response: StoredIdempotentResponse = {
    status: 201,
    body: {
      rootVersionId: versionId,
      assetId: canonicalAssetId,
    } satisfies SampleImportResponse,
  };

  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayOrNull(db, projectId, idempotencyKey, operation, requestHash);
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      assertProjectCanCreateRoot(db, projectId);

      db.insert(assets)
        .values({
          id: originalAssetId,
          projectId,
          kind: "original",
          relativePath: originalWrite.relativePath,
          sha256: originalWrite.sha256,
          mimeType: originalInfo.mimeType,
          width: originalInfo.width,
          height: originalInfo.height,
          bytes: sourceBytes.length,
          createdAt: now,
        })
        .run();

      db.insert(assets)
        .values({
          id: canonicalAssetId,
          projectId,
          kind: "canonical",
          relativePath: canonicalWrite.relativePath,
          sha256: canonicalWrite.sha256,
          mimeType: "image/png",
          width: canonical.width,
          height: canonical.height,
          bytes: canonical.bytes.length,
          createdAt: now,
        })
        .run();

      db.insert(versions)
        .values({
          id: versionId,
          projectId,
          parentVersionId: null,
          imageAssetId: canonicalAssetId,
          origin: "sample",
          originalAssetId,
          sourceMetadataJson: sourceMetadata,
          originatingRunId: null,
          createdAt: now,
        })
        .run();

      db.update(projects)
        .set({ rootVersionId: versionId, activeVersionId: versionId })
        .where(eq(projects.id, projectId))
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
    const replayAfterConstraint = handleImportConstraint(
      db,
      projectId,
      idempotencyKey,
      operation,
      requestHash,
      true,
      error,
    );
    if (replayAfterConstraint !== null) return replayAfterConstraint;
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

export async function importUploadedAsset(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  projectId: string;
  role: AssetRole;
  bytes: Buffer;
  idempotencyKey: string;
}): Promise<StoredIdempotentResponse> {
  const { handle, env, projectId, role, bytes, idempotencyKey } = input;
  const { db, sqlite } = handle;

  getProjectOrThrow(db, projectId);

  const operation = "asset_import";
  const fileSha256 = sha256Hex(bytes);
  const requestHash = hashRequest({ operation, projectId, role, fileSha256 });
  const replay = replayOrNull(db, projectId, idempotencyKey, operation, requestHash);
  if (replay !== null) return replay;

  const originalInfo = await inspectImage(bytes);
  const normalized =
    role === "base"
      ? await normalizeBase(bytes, originalInfo)
      : await normalizeReference(bytes, originalInfo);

  const originalAssetId = randomUUID();
  const normalizedAssetId = randomUUID();
  const versionId = role === "base" ? randomUUID() : null;
  const now = Date.now();

  const originalWrite = await writeAssetBytes({
    assetDir: env.assetDir,
    projectId,
    assetId: originalAssetId,
    mimeType: originalInfo.mimeType,
    bytes,
  });
  const normalizedWrite = await writeAssetBytes({
    assetDir: env.assetDir,
    projectId,
    assetId: normalizedAssetId,
    mimeType: "image/png",
    bytes: normalized.bytes,
  });

  const response: StoredIdempotentResponse = {
    status: 201,
    body: {
      assetId: normalizedAssetId,
      rootVersionId: versionId,
      width: normalized.width,
      height: normalized.height,
    } satisfies AssetUploadResponse,
  };

  let replayResult: StoredIdempotentResponse | null = null;

  try {
    immediateTransaction(sqlite, () => {
      const concurrentReplay = replayOrNull(db, projectId, idempotencyKey, operation, requestHash);
      if (concurrentReplay !== null) {
        replayResult = concurrentReplay;
        return;
      }

      if (role === "base") {
        assertProjectCanCreateRoot(db, projectId);
      } else {
        getProjectOrThrow(db, projectId);
      }

      db.insert(assets)
        .values({
          id: originalAssetId,
          projectId,
          kind: "original",
          relativePath: originalWrite.relativePath,
          sha256: originalWrite.sha256,
          mimeType: originalInfo.mimeType,
          width: originalInfo.width,
          height: originalInfo.height,
          bytes: bytes.length,
          createdAt: now,
        })
        .run();

      db.insert(assets)
        .values({
          id: normalizedAssetId,
          projectId,
          kind: role === "base" ? "canonical" : "reference",
          relativePath: normalizedWrite.relativePath,
          sha256: normalizedWrite.sha256,
          mimeType: "image/png",
          width: normalized.width,
          height: normalized.height,
          bytes: normalized.bytes.length,
          createdAt: now,
        })
        .run();

      if (role === "base" && versionId !== null) {
        db.insert(versions)
          .values({
            id: versionId,
            projectId,
            parentVersionId: null,
            imageAssetId: normalizedAssetId,
            origin: "upload",
            originalAssetId,
            sourceMetadataJson: null,
            originatingRunId: null,
            createdAt: now,
          })
          .run();

        db.update(projects)
          .set({ rootVersionId: versionId, activeVersionId: versionId })
          .where(eq(projects.id, projectId))
          .run();
      }

      insertIdempotency(db, {
        projectId,
        key: idempotencyKey,
        operation,
        requestHash,
        response,
      });
    });
  } catch (error) {
    const replayAfterConstraint = handleImportConstraint(
      db,
      projectId,
      idempotencyKey,
      operation,
      requestHash,
      role === "base",
      error,
    );
    if (replayAfterConstraint !== null) return replayAfterConstraint;
    throw error;
  }

  if (replayResult !== null) return replayResult;
  return response;
}

export function getAssetOrThrow(db: AppDatabase, assetId: string): AssetRow {
  const asset = db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (asset === undefined) {
    throw new AppError(404, "NOT_FOUND", "Asset was not found.");
  }
  return asset;
}

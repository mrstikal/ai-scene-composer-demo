import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { CostConsent, RunSummaryDto } from "../src/lib/contracts/api";
import { getPricingConfig } from "../src/lib/config/pricing";
import { fixturesRoot, readFixtureManifest } from "../src/lib/config/fixtures";
import { parseEnv, type AppEnv } from "../src/lib/config/env";
import { getProjectCosts } from "../src/lib/costs/service";
import { createDatabase, type DatabaseHandle } from "../src/lib/db/client";
import { migrateDatabase } from "../src/lib/db/migrate";
import { enqueueComparison, comparisonReservationUsdMicros } from "../src/lib/comparisons/service";
import { editReservationUsdMicros, enqueueEdit } from "../src/lib/edits/service";
import { enqueueGeneration } from "../src/lib/generations/service";
import { createProductionHandlers } from "../src/lib/jobs/handlers";
import { runOnce } from "../src/lib/jobs/worker";
import {
  createProject,
  getProjectSnapshot,
  importSample,
  importUploadedAsset,
  setActiveVersion,
} from "../src/lib/projects/service";
import { enqueueSegmentation, segmentationReservationUsdMicros } from "../src/lib/segmentations/service";

const IMAGE_CALLS = 8;
const SAM_CALLS = 4;

interface StepRecord {
  step: string;
  runIds: string[];
  status: string;
  models: string[];
  costs: Array<{
    runId: string;
    status: string;
    amountUsdMicros: number | null;
    provenance: string | null;
    outcome: string | null;
    latencyMs: number | null;
  }>;
  metrics: Array<{
    runId: string;
    nativeWidth: number | null;
    nativeHeight: number | null;
    normalizedWidth: number | null;
    normalizedHeight: number | null;
    protectedPixelCount: number | null;
    protectedMismatchPixels: number | null;
    rawBackgroundMae: number | null;
    finalBackgroundMae: number | null;
  }>;
  outputVersionIds: string[];
  comparisonGroupId?: string;
}

interface LiveReport {
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "passed" | "failed";
  databasePath: string;
  assetDir: string;
  plannedCalls: { image: number; sam: number };
  projects: Record<string, { projectId: string; steps: StepRecord[]; costs?: unknown }>;
  error: string | null;
}

function fail(message: string): never {
  throw new Error(message);
}

function consent(reservationUsdMicros: number): CostConsent {
  return {
    pricingVersion: getPricingConfig().version,
    reservationUsdMicros,
    acknowledged: true,
  };
}

function requireSucceeded(snapshot: ReturnType<typeof getProjectSnapshot>, runId: string): RunSummaryDto {
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) fail(`Run ${runId} is missing from the project snapshot.`);
  if (run.status !== "succeeded") {
    fail(
      `Run ${runId} ended as ${run.status}: ${run.errorCode ?? "unknown"} ${run.errorMessage ?? ""}`.trim(),
    );
  }
  return run;
}

async function runUntilIdle(input: {
  handle: DatabaseHandle;
  env: AppEnv;
  handlers: ReturnType<typeof createProductionHandlers>;
  step: string;
  projectId: string;
}): Promise<void> {
  for (;;) {
    const result = await runOnce({
      db: input.handle.db,
      sqlite: input.handle.sqlite,
      env: input.env,
      handlers: input.handlers,
    });
    if (result.status === "idle") return;
    if (result.status === "failed") {
      const snapshot = getProjectSnapshot(input.handle.db, input.projectId, input.env);
      const run = snapshot.runs.find((candidate) => candidate.id === result.runId);
      fail(
        `${input.step}: worker failed run ${result.runId ?? "unknown"} (${run?.errorCode ?? result.errorCode ?? "unknown"}): ${run?.errorMessage ?? "no message"}`,
      );
    }
  }
}

function stepRecord(input: {
  step: string;
  snapshot: ReturnType<typeof getProjectSnapshot>;
  runIds: string[];
  comparisonGroupId?: string;
}): StepRecord {
  const runs = input.runIds.map((runId) => {
    const run = input.snapshot.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) fail(`${input.step}: run ${runId} is missing.`);
    return run;
  });

  return {
    step: input.step,
    runIds: runs.map((run) => run.id),
    status: runs.map((run) => run.status).join(","),
    models: runs.map((run) => run.model),
    costs: runs.map((run) => ({
      runId: run.id,
      status: run.status,
      amountUsdMicros: run.cost.amountUsdMicros,
      provenance: run.cost.provenance,
      outcome: run.cost.outcome,
      latencyMs: run.providerLatencyMs,
    })),
    metrics: runs.map((run) => ({
      runId: run.id,
      nativeWidth: run.metrics?.nativeWidth ?? null,
      nativeHeight: run.metrics?.nativeHeight ?? null,
      normalizedWidth: run.metrics?.normalizedWidth ?? null,
      normalizedHeight: run.metrics?.normalizedHeight ?? null,
      protectedPixelCount: run.metrics?.protectedPixelCount ?? null,
      protectedMismatchPixels: run.metrics?.protectedMismatchPixels ?? null,
      rawBackgroundMae: run.metrics?.rawBackgroundMae ?? null,
      finalBackgroundMae: run.metrics?.finalBackgroundMae ?? null,
    })),
    outputVersionIds: runs
      .map((run) => run.outputVersionId)
      .filter((value): value is string => value !== null),
    ...(input.comparisonGroupId === undefined
      ? {}
      : { comparisonGroupId: input.comparisonGroupId }),
  };
}

async function main(): Promise<void> {
  nextEnv.loadEnvConfig(process.cwd());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  process.env.DATABASE_PATH = `./data/live-dod-${stamp}.sqlite`;
  process.env.ASSET_DIR = `./assets-local/live-dod-${stamp}`;
  const env = parseEnv(process.env, process.cwd());

  if (env.runLiveAiTests !== "1" || env.aiMode !== "live") {
    fail("Live DoD requires RUN_LIVE_AI_TESTS=1 and AI_MODE=live. No network calls were made.");
  }
  if (env.samMode !== "live") {
    fail("Live DoD requires SAM_MODE=live. No network calls were made.");
  }
  if (env.openRouterApiKey === null || env.metaModelApiKey === null) {
    fail("Live DoD requires both OPENROUTER_API_KEY and META_MODEL_API_KEY. No network calls were made.");
  }
  if (process.env.LIVE_DOD_APPROVED !== "1") {
    fail("Live DoD requires LIVE_DOD_APPROVED=1 as explicit spend authorization. No network calls were made.");
  }

  const manifest = readFixtureManifest(env.repoRoot);
  if (!manifest.licensedPhotosReady) {
    fail("Live DoD requires licensed source and reference photographs. No network calls were made.");
  }
  for (const fixture of manifest.fixtures) {
    if (!fixture.selectedPath.startsWith("photos/")) {
      fail(`Fixture ${fixture.fixtureId} is not a licensed photograph. No network calls were made.`);
    }
  }

  const root = fixturesRoot(env.repoRoot);
  const referenceBytes = await readFile(join(root, "photos/reference-sofa-v1.jpg"));

  process.stdout.write(
    `Live DoD modes: ai=${env.aiMode} sam=${env.samMode}; planned calls: ${IMAGE_CALLS} image, ${SAM_CALLS} SAM.\n` +
      `Database: ${env.databasePath}\nAssets: ${env.assetDir}\n` +
      `Image reservation: ${env.imageReservationUsdMicros} micro-USD; comparison: ${comparisonReservationUsdMicros(env)} micro-USD.\n`,
  );

  const handle = createDatabase(env.databasePath);
  migrateDatabase(handle.db);
  const handlers = createProductionHandlers();
  const report: LiveReport = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    databasePath: relative(process.cwd(), env.databasePath),
    assetDir: relative(process.cwd(), env.assetDir),
    plannedCalls: { image: IMAGE_CALLS, sam: SAM_CALLS },
    projects: {},
    error: null,
  };

  const reportPath = join(process.cwd(), "docs/live-dod-report.json");
  await mkdir(join(process.cwd(), "docs"), { recursive: true });

  async function saveReport(): Promise<void> {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  try {
    const walkthrough = createProject(handle.db, env, "Live DoD Walkthrough");
    report.projects.walkthrough = { projectId: walkthrough.id, steps: [] };

    const generation = await enqueueGeneration({
      handle,
      env,
      projectId: walkthrough.id,
      generationInput: { mode: "preset", presetId: "cozy-living-room" },
      costConsent: consent(env.imageReservationUsdMicros),
      idempotencyKey: randomUUID(),
    });
    const generationRunId = (generation.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "preset generation", projectId: walkthrough.id });
    let snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    requireSucceeded(snapshot, generationRunId);
    const rootVersionId = snapshot.project.rootVersionId;
    if (rootVersionId === null) fail("Preset generation did not install a root Version.");
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "preset-generation", snapshot, runIds: [generationRunId] }),
    );
    await saveReport();

    const positive = await enqueueSegmentation({
      handle,
      env,
      projectId: walkthrough.id,
      sourceVersionId: rootVersionId,
      positivePoints: [{ x: 512, y: 500 }],
      negativePoints: [],
      costConsent: consent(segmentationReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const positiveRunId = (positive.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "SAM positive selection", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    const positiveRun = requireSucceeded(snapshot, positiveRunId);
    if (positiveRun.outputSelectionId === null) fail("SAM positive selection created no Selection.");
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "sam-positive", snapshot, runIds: [positiveRunId] }),
    );
    await saveReport();

    const correction = await enqueueSegmentation({
      handle,
      env,
      projectId: walkthrough.id,
      sourceVersionId: rootVersionId,
      positivePoints: [{ x: 500, y: 600 }],
      negativePoints: [{ x: 100, y: 550 }],
      costConsent: consent(segmentationReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const correctionRunId = (correction.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "SAM negative correction", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    const correctionRun = requireSucceeded(snapshot, correctionRunId);
    if (correctionRun.outputSelectionId === null) fail("SAM correction created no Selection.");
    const correctedSelectionId = correctionRun.outputSelectionId;
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "sam-correction", snapshot, runIds: [correctionRunId] }),
    );
    await saveReport();

    const reference = await importUploadedAsset({
      handle,
      env,
      projectId: walkthrough.id,
      role: "reference",
      bytes: referenceBytes,
      idempotencyKey: randomUUID(),
    });
    const referenceAssetId = (reference.body as { assetId: string }).assetId;

    const comparison = await enqueueComparison({
      handle,
      env,
      projectId: walkthrough.id,
      parentVersionId: rootVersionId,
      selectionId: correctedSelectionId,
      paddingPx: 16,
      targetLabel: "sofa",
      instruction:
        "Replace the sofa with the black tufted leather sofa shown in Image 2, matching its shape and proportions while preserving the room, lamp, wall art and floor.",
      referenceAssetIds: [referenceAssetId],
      costConsent: consent(comparisonReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const comparisonBody = comparison.body as { comparisonGroupId: string; runIds: [string, string] };
    await runUntilIdle({ handle, env, handlers, step: "reference comparison", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    const flareRun = requireSucceeded(snapshot, comparisonBody.runIds[0]);
    const sunburstRun = requireSucceeded(snapshot, comparisonBody.runIds[1]);
    if (flareRun.outputVersionId === null || sunburstRun.outputVersionId === null) {
      fail("A comparison candidate produced no Version.");
    }
    report.projects.walkthrough.steps.push(
      stepRecord({
        step: "reference-comparison",
        snapshot,
        runIds: comparisonBody.runIds,
        comparisonGroupId: comparisonBody.comparisonGroupId,
      }),
    );
    await saveReport();

    setActiveVersion(handle.db, walkthrough.id, flareRun.outputVersionId);

    const childSelection = await enqueueSegmentation({
      handle,
      env,
      projectId: walkthrough.id,
      sourceVersionId: flareRun.outputVersionId,
      positivePoints: [{ x: 930, y: 250 }],
      negativePoints: [{ x: 512, y: 500 }],
      costConsent: consent(segmentationReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const childSelectionRunId = (childSelection.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "child SAM selection", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    const childSelectionRun = requireSucceeded(snapshot, childSelectionRunId);
    if (childSelectionRun.outputSelectionId === null) fail("Child SAM selection created no Selection.");
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "child-sam", snapshot, runIds: [childSelectionRunId] }),
    );
    await saveReport();

    const childEdit = await enqueueEdit({
      handle,
      env,
      projectId: walkthrough.id,
      parentVersionId: flareRun.outputVersionId,
      selectionId: childSelectionRun.outputSelectionId,
      paddingPx: 16,
      targetLabel: "floor lamp",
      instruction:
        "Change the floor lamp shade to warm amber glass while preserving the lamp base, sofa and the rest of the room.",
      referenceAssetIds: [],
      model: "openai/gpt-image-2.5-flare",
      costConsent: consent(editReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const childEditRunId = (childEdit.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "child edit", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    requireSucceeded(snapshot, childEditRunId);
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "child-edit", snapshot, runIds: [childEditRunId] }),
    );
    await saveReport();

    setActiveVersion(handle.db, walkthrough.id, rootVersionId);
    const branchEdit = await enqueueEdit({
      handle,
      env,
      projectId: walkthrough.id,
      parentVersionId: rootVersionId,
      selectionId: correctedSelectionId,
      paddingPx: 32,
      targetLabel: "sofa",
      instruction:
        "Recolor the sofa upholstery to deep green velvet while preserving its shape, pillows, lamp, wall art and the rest of the room.",
      referenceAssetIds: [],
      model: "openai/gpt-image-2.5-sunburst",
      costConsent: consent(editReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const branchEditRunId = (branchEdit.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "root branch edit", projectId: walkthrough.id });
    snapshot = getProjectSnapshot(handle.db, walkthrough.id, env);
    requireSucceeded(snapshot, branchEditRunId);
    report.projects.walkthrough.steps.push(
      stepRecord({ step: "root-branch-edit", snapshot, runIds: [branchEditRunId] }),
    );
    report.projects.walkthrough.costs = getProjectCosts(handle.db, walkthrough.id);
    await saveReport();

    const custom = createProject(handle.db, env, "Live DoD Custom Prompt");
    report.projects.custom = { projectId: custom.id, steps: [] };
    const customGeneration = await enqueueGeneration({
      handle,
      env,
      projectId: custom.id,
      generationInput: {
        mode: "custom",
        prompt:
          "A photorealistic sunlit reading corner with a green velvet armchair, brass floor lamp, small wooden side table and a large window, no people.",
      },
      costConsent: consent(env.imageReservationUsdMicros),
      idempotencyKey: randomUUID(),
    });
    const customRunId = (customGeneration.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "custom generation", projectId: custom.id });
    snapshot = getProjectSnapshot(handle.db, custom.id, env);
    requireSucceeded(snapshot, customRunId);
    if (snapshot.project.rootVersionId === null) fail("Custom generation did not install a root Version.");
    report.projects.custom.steps.push(
      stepRecord({ step: "custom-generation", snapshot, runIds: [customRunId] }),
    );
    report.projects.custom.costs = getProjectCosts(handle.db, custom.id);
    await saveReport();

    const recolor = createProject(handle.db, env, "Live DoD Recolor Sofa");
    report.projects.recolor = { projectId: recolor.id, steps: [] };
    const sample = await importSample({
      handle,
      env,
      projectId: recolor.id,
      sampleId: "living-room-v1",
      idempotencyKey: randomUUID(),
    });
    const recolorRootId = (sample.body as { rootVersionId: string }).rootVersionId;
    const recolorSelection = await enqueueSegmentation({
      handle,
      env,
      projectId: recolor.id,
      sourceVersionId: recolorRootId,
      positivePoints: [{ x: 512, y: 750 }],
      negativePoints: [],
      costConsent: consent(segmentationReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const recolorSelectionRunId = (recolorSelection.body as { runId: string }).runId;
    await runUntilIdle({ handle, env, handlers, step: "recolor SAM selection", projectId: recolor.id });
    snapshot = getProjectSnapshot(handle.db, recolor.id, env);
    const recolorSelectionRun = requireSucceeded(snapshot, recolorSelectionRunId);
    if (recolorSelectionRun.outputSelectionId === null) {
      fail("Recolor SAM selection created no Selection.");
    }
    report.projects.recolor.steps.push(
      stepRecord({ step: "recolor-sam", snapshot, runIds: [recolorSelectionRunId] }),
    );

    const recolorComparison = await enqueueComparison({
      handle,
      env,
      projectId: recolor.id,
      parentVersionId: recolorRootId,
      selectionId: recolorSelectionRun.outputSelectionId,
      paddingPx: 16,
      targetLabel: "sofa",
      instruction:
        "Recolor the sofa upholstery to deep green velvet while preserving the sofa shape, pillows, lamp, wall art and the rest of the room.",
      referenceAssetIds: [],
      costConsent: consent(comparisonReservationUsdMicros(env)),
      idempotencyKey: randomUUID(),
    });
    const recolorBody = recolorComparison.body as { comparisonGroupId: string; runIds: [string, string] };
    await runUntilIdle({ handle, env, handlers, step: "recolor comparison", projectId: recolor.id });
    snapshot = getProjectSnapshot(handle.db, recolor.id, env);
    requireSucceeded(snapshot, recolorBody.runIds[0]);
    requireSucceeded(snapshot, recolorBody.runIds[1]);
    report.projects.recolor.steps.push(
      stepRecord({
        step: "recolor-comparison",
        snapshot,
        runIds: recolorBody.runIds,
        comparisonGroupId: recolorBody.comparisonGroupId,
      }),
    );
    report.projects.recolor.costs = getProjectCosts(handle.db, recolor.id);
    await saveReport();

    handle.close();
    const reopened = createDatabase(env.databasePath);
    try {
      const walkthroughAfter = getProjectSnapshot(reopened.db, walkthrough.id, env);
      const customAfter = getProjectSnapshot(reopened.db, custom.id, env);
      const recolorAfter = getProjectSnapshot(reopened.db, recolor.id, env);
      if (walkthroughAfter.versions.length < 5) fail("Walkthrough Versions did not survive restart.");
      if (customAfter.project.rootVersionId === null) fail("Custom root did not survive restart.");
      if (recolorAfter.versions.length < 1) fail("Recolor root did not survive restart.");
      report.projects.walkthrough.costs = getProjectCosts(reopened.db, walkthrough.id);
      report.projects.custom.costs = getProjectCosts(reopened.db, custom.id);
      report.projects.recolor.costs = getProjectCosts(reopened.db, recolor.id);
    } finally {
      reopened.close();
    }

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await saveReport();
    process.stdout.write(`Live DoD passed. Report: ${reportPath}\n`);
  } catch (error) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = error instanceof Error ? error.message : "Live DoD failed.";
    await saveReport();
    process.stderr.write(`${report.error}\n`);
    process.exitCode = 1;
  } finally {
    try {
      handle.close();
    } catch {
      // The handle may already be closed after the restart check.
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Live DoD failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

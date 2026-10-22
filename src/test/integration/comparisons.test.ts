import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "@/lib/config/env";
import { getPricingConfig } from "@/lib/config/pricing";
import type { CostConsent } from "@/lib/contracts/api";
import { editSnapshotSchema } from "@/lib/contracts/domain";
import { getComparisonDetail } from "@/lib/comparisons/read";
import {
  comparisonReservationUsdMicros,
  enqueueComparison,
} from "@/lib/comparisons/service";
import { getProjectCosts } from "@/lib/costs/service";
import { idempotencyKeys, runs, usageEvents } from "@/lib/db/schema";
import { saveRunEvaluation } from "@/lib/evaluation/service";
import { createEditHandler, type EditHandlerOptions } from "@/lib/jobs/handlers/edit";
import { createSegmentHandler } from "@/lib/jobs/handlers/segment";
import { runOnce } from "@/lib/jobs/worker";
import { enqueueRetry } from "@/lib/runs/retry";
import {
  createProject,
  getProjectSnapshot,
  importSample,
} from "@/lib/projects/service";
import { enqueueSegmentation } from "@/lib/segmentations/service";
import { createTestEnvironment, createTestImage, type TestEnvironment } from "@/test/helpers/environment";
import type { ImageEditAdapter, ImageGenerationResult } from "@/lib/providers/types";

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
});

afterEach(async () => {
  await testEnv.cleanup();
});

function consent(reservationUsdMicros = 0): CostConsent {
  return {
    pricingVersion: getPricingConfig().version,
    reservationUsdMicros,
    acknowledged: true,
  };
}

function liveEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...testEnv.env,
    aiMode: "live",
    openRouterApiKey: "test-openrouter-key",
    ...overrides,
  };
}

async function sampleProject(env: AppEnv = testEnv.env): Promise<{
  projectId: string;
  rootVersionId: string;
}> {
  const project = createProject(testEnv.handle.db, env, "Comparison");
  const imported = await importSample({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId: project.id,
    sampleId: "living-room-v1",
    idempotencyKey: randomUUID(),
  });
  return {
    projectId: project.id,
    rootVersionId: (imported.body as { rootVersionId: string }).rootVersionId,
  };
}

async function createSelection(projectId: string, sourceVersionId: string): Promise<string> {
  const stored = await enqueueSegmentation({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId,
    sourceVersionId,
    positivePoints: [{ x: 420, y: 610 }],
    negativePoints: [],
    costConsent: consent(0),
    idempotencyKey: randomUUID(),
  });
  await runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env: testEnv.env,
    handlers: { segment: createSegmentHandler() },
  });
  const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
  const selection = snapshot.selections
    .filter((candidate) => candidate.sourceVersionId === sourceVersionId)
    .at(-1);
  if (selection === undefined) {
    throw new Error(`Selection for ${(stored.body as { runId: string }).runId} is missing.`);
  }
  return selection.id;
}

function imageAdapter(result: ImageGenerationResult): ImageEditAdapter {
  return { edit: async () => result };
}

async function editImage(): Promise<ImageGenerationResult> {
  return {
    kind: "image",
    bytes: await createTestImage({ width: 1024, height: 1024 }),
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    providerRequestId: "req_edit",
    usage: null,
    observedCostUsdMicros: null,
    latencyMs: 25,
  };
}

function runEdit(adapterFactory?: EditHandlerOptions["adapterFactory"], env: AppEnv = testEnv.env) {
  return runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env,
    handlers: { edit: createEditHandler({ adapterFactory }) },
  });
}

async function enqueueComparisonFor(input: {
  projectId: string;
  parentVersionId: string;
  selectionId: string;
  env?: AppEnv;
  key?: string;
}) {
  const env = input.env ?? testEnv.env;
  return enqueueComparison({
    handle: testEnv.handle,
    env,
    projectId: input.projectId,
    parentVersionId: input.parentVersionId,
    selectionId: input.selectionId,
    paddingPx: 16,
    targetLabel: "sofa",
    instruction: "Make the sofa green.",
    referenceAssetIds: [],
    costConsent: consent(comparisonReservationUsdMicros(env)),
    idempotencyKey: input.key ?? randomUUID(),
  });
}

describe("comparison enqueue", () => {
  it("creates two sibling runs with frozen shared input and no source chaining", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const key = randomUUID();
    const stored = await enqueueComparisonFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      key,
    });
    expect(stored.status).toBe(202);
    const body = stored.body as { comparisonGroupId: string; runIds: [string, string] };
    expect(body.runIds).toHaveLength(2);

    const replay = await enqueueComparisonFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      key,
    });
    expect(replay.body).toEqual(body);

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const groupRuns = snapshot.runs.filter(
      (run) => run.comparisonGroupId === body.comparisonGroupId,
    );
    expect(groupRuns).toHaveLength(2);
    expect(groupRuns.map((run) => run.id).sort()).toEqual([...body.runIds].sort());
    expect([...groupRuns.map((run) => run.model)].sort()).toEqual([
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.5-sunburst",
    ]);
    expect(new Set(groupRuns.map((run) => run.commonInputHash)).size).toBe(1);
    expect(new Set(groupRuns.map((run) => run.parentVersionId))).toEqual(
      new Set([rootVersionId]),
    );
    expect(new Set(groupRuns.map((run) => run.editInput?.selectionId))).toEqual(
      new Set([selectionId]),
    );
    expect(groupRuns.every((run) => run.status === "queued")).toBe(true);

    const rows = testEnv.handle.db
      .select()
      .from(runs)
      .where(eq(runs.comparisonGroupId, body.comparisonGroupId))
      .all();
    const snapshots = rows.map((row) => {
      const parsed = editSnapshotSchema.safeParse(row.inputSnapshotJson);
      if (!parsed.success) throw new Error("Comparison snapshot is invalid.");
      return parsed.data;
    });
    const [flare, sunburst] = snapshots;
    if (flare === undefined || sunburst === undefined) throw new Error("Snapshots are missing.");
    expect(flare.model).toBe("openai/gpt-image-2.5-flare");
    expect(sunburst.model).toBe("openai/gpt-image-2.5-sunburst");
    const sharedFields = [
      "parentVersionId",
      "sourceAssetId",
      "sourceSha256",
      "selectionId",
      "paddingPx",
      "featherPx",
      "targetLabel",
      "instruction",
      "prompt",
      "promptSha256",
      "referenceAssetIds",
      "referenceSha256",
      "transportOptions",
      "pricingVersion",
      "capabilityVersion",
      "reservationUsdMicros",
      "executionMode",
    ] as const;
    for (const field of sharedFields) {
      expect(flare[field]).toEqual(sunburst[field]);
    }

    await runEdit();
    await runEdit();
    const completed = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const completedRuns = completed.runs.filter(
      (run) => run.comparisonGroupId === body.comparisonGroupId,
    );
    expect(completedRuns.every((run) => run.status === "succeeded")).toBe(true);
    expect(completedRuns.every((run) => run.parentVersionId === rootVersionId)).toBe(true);
    expect(new Set(completedRuns.map((run) => run.outputVersionId)).size).toBe(2);
    expect(completed.project.activeVersionId).toBe(rootVersionId);

    const detail = getComparisonDetail(testEnv.handle.db, body.comparisonGroupId, testEnv.env);
    expect(detail.runs).toHaveLength(2);
    expect(detail.sharedSelectionCost).toMatchObject({
      selectionId,
      amountUsdMicros: 0,
      provenance: "calculated",
      outcome: "completed",
    });
    expect(detail.candidateCost.knownUsdMicros).toBe(0);
    expect(detail.candidateCost.byModel).toHaveLength(2);
    expect(detail.candidateCost.byModel.map((entry) => entry.model)).toEqual([
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.5-sunburst",
    ]);

    const costs = getProjectCosts(testEnv.handle.db, projectId);
    expect(costs.totals.commitmentUsdMicros).toBe(0);
    expect(costs.totals.calculatedUsdMicros).toBe(0);
    expect(costs.events).toHaveLength(3);
    expect(costs.byOperation).toEqual([
      expect.objectContaining({ operation: "segment", calculatedUsdMicros: 0 }),
      expect.objectContaining({ operation: "edit", calculatedUsdMicros: 0 }),
    ]);
  });

  it("fails the whole comparison atomically when the combined reservation exceeds the budget", async () => {
    const lowBudgetEnv = { ...testEnv.env, projectBudgetUsdMicros: 250_000 };
    const { projectId, rootVersionId } = await sampleProject(lowBudgetEnv);
    const selectionId = await createSelection(projectId, rootVersionId);
    const env = liveEnv();
    const key = randomUUID();

    await expect(
      enqueueComparisonFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        env,
        key,
      }),
    ).rejects.toMatchObject({ status: 402, code: "BUDGET_EXCEEDED" });

    const projectRuns = testEnv.handle.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .all();
    expect(projectRuns.filter((run) => run.kind === "edit")).toHaveLength(0);
    expect(projectRuns).toHaveLength(1);
    const usage = testEnv.handle.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, projectId))
      .all();
    expect(usage).toHaveLength(1);
    const idempotency = testEnv.handle.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.projectId, projectId), eq(idempotencyKeys.key, key)))
      .all();
    expect(idempotency).toHaveLength(0);
  });

  it("rejects a consent amount that does not equal two image reservations", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const env = liveEnv();
    await expect(
      enqueueComparison({
        handle: testEnv.handle,
        env,
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        paddingPx: 16,
        targetLabel: "sofa",
        instruction: "Make the sofa green.",
        referenceAssetIds: [],
        costConsent: consent(250_000),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "PRICING_CHANGED" });
  });
});

describe("comparison partial failure and single-candidate retry", () => {
  it("keeps the sibling result, retains the group and common hash, and records attempt history", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const env = liveEnv();
    const stored = await enqueueComparisonFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    const group = stored.body as { comparisonGroupId: string; runIds: [string, string] };

    const success = await editImage();
    const adapterFactory = (run: { model: string }): ImageEditAdapter =>
      run.model === "openai/gpt-image-2.5-sunburst"
        ? imageAdapter({
            kind: "rejected",
            message: "OpenRouter rejected the request (HTTP 402).",
            httpStatus: 402,
            providerRequestId: "req_rejected",
            usage: null,
            observedCostUsdMicros: null,
            latencyMs: 10,
          })
        : imageAdapter(success);

    await runEdit(adapterFactory, env);
    await runEdit(adapterFactory, env);

    let snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    let groupRuns = snapshot.runs.filter(
      (run) => run.comparisonGroupId === group.comparisonGroupId,
    );
    expect(groupRuns).toHaveLength(2);
    const flareRun = groupRuns.find((run) => run.model.includes("flare"));
    const failedSunburst = groupRuns.find((run) => run.model.includes("sunburst"));
    if (flareRun === undefined || failedSunburst === undefined) {
      throw new Error("Comparison candidates are missing.");
    }
    expect(flareRun.status).toBe("succeeded");
    expect(failedSunburst.status).toBe("failed");
    expect(failedSunburst.retryMode).toBe("provider");
    expect(flareRun.retryMode).toBe("none");

    let detail = getComparisonDetail(testEnv.handle.db, group.comparisonGroupId, env);
    expect(detail.candidateCost.knownUsdMicros).toBe(250_000);
    expect(detail.candidateCost.unknownAmountRuns).toBe(0);
    expect(detail.candidateCost.byModel).toEqual([
      expect.objectContaining({
        model: "openai/gpt-image-2.5-flare",
        knownUsdMicros: 250_000,
        runIds: [flareRun.id],
      }),
      expect.objectContaining({
        model: "openai/gpt-image-2.5-sunburst",
        knownUsdMicros: 0,
        runIds: [failedSunburst.id],
      }),
    ]);

    const retry = await enqueueRetry({
      handle: testEnv.handle,
      env,
      runId: failedSunburst.id,
      costConsent: consent(250_000),
      acknowledgePossibleDuplicateCharge: false,
      idempotencyKey: randomUUID(),
    });
    const retryRunId = (retry.body as { runId: string }).runId;
    await runEdit(() => imageAdapter(success), env);

    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    groupRuns = snapshot.runs.filter((run) => run.comparisonGroupId === group.comparisonGroupId);
    expect(groupRuns).toHaveLength(3);
    const retried = groupRuns.find((run) => run.id === retryRunId);
    if (retried === undefined) throw new Error("Retry run is missing.");
    expect(retried).toMatchObject({
      status: "succeeded",
      model: "openai/gpt-image-2.5-sunburst",
      comparisonGroupId: group.comparisonGroupId,
      retryOfRunId: failedSunburst.id,
      commonInputHash: failedSunburst.commonInputHash,
    });
    const flareAfter = groupRuns.find((run) => run.id === flareRun.id);
    expect(flareAfter?.outputVersionId).toBe(flareRun.outputVersionId);
    expect(flareAfter?.status).toBe("succeeded");

    detail = getComparisonDetail(testEnv.handle.db, group.comparisonGroupId, env);
    expect(detail.candidateCost.knownUsdMicros).toBe(500_000);
    expect(detail.candidateCost.byModel).toEqual([
      expect.objectContaining({ model: "openai/gpt-image-2.5-flare", runIds: [flareRun.id] }),
      expect.objectContaining({
        model: "openai/gpt-image-2.5-sunburst",
        runIds: [failedSunburst.id, retryRunId],
      }),
    ]);

    const costs = getProjectCosts(testEnv.handle.db, projectId);
    expect(costs.totals.estimatedUsdMicros).toBe(500_000);
    expect(costs.totals.commitmentUsdMicros).toBe(500_000);
    expect(costs.totals.activeReservationUsdMicros).toBe(0);
    expect(costs.totals.unknownHoldUsdMicros).toBe(0);

    const evaluation = {
      boundaryArtifacts: 4,
      promptAdherence: 5,
      referenceFidelity: null,
      plausibility: 3,
      notes: "  keep surrounding spaces  ",
    };
    saveRunEvaluation(testEnv.handle.db, flareRun.id, evaluation);
    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.runs.find((run) => run.id === flareRun.id)?.evaluation).toEqual(evaluation);

    const updated = { ...evaluation, promptAdherence: 2, notes: "Updated." };
    saveRunEvaluation(testEnv.handle.db, flareRun.id, updated);
    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.runs.find((run) => run.id === flareRun.id)?.evaluation).toEqual(updated);

    expect(() =>
      saveRunEvaluation(testEnv.handle.db, flareRun.id, {
        ...evaluation,
        referenceFidelity: 5,
      }),
    ).toThrow("Reference fidelity must be null");
    expect(() => saveRunEvaluation(testEnv.handle.db, failedSunburst.id, evaluation)).toThrow(
      "Evaluation requires a successful edit run",
    );
  });
});

describe("shared selection cost", () => {
  it("reports the originating SAM event once and excludes it from candidate cost", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const segmentRun = testEnv.handle.db
      .select()
      .from(runs)
      .where(eq(runs.kind, "segment"))
      .get();
    if (segmentRun === undefined) throw new Error("Segment run is missing.");
    testEnv.handle.db
      .update(runs)
      .set({ budgetChargeUsdMicros: 2_500 })
      .where(eq(runs.id, segmentRun.id))
      .run();
    testEnv.handle.db
      .update(usageEvents)
      .set({ amountUsdMicros: 2_500, costProvenance: "provider" })
      .where(eq(usageEvents.runId, segmentRun.id))
      .run();

    const stored = await enqueueComparisonFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
    });
    const group = stored.body as { comparisonGroupId: string };
    await runEdit();
    await runEdit();

    const detail = getComparisonDetail(testEnv.handle.db, group.comparisonGroupId, testEnv.env);
    expect(detail.sharedSelectionCost).toMatchObject({
      selectionId,
      runId: segmentRun.id,
      amountUsdMicros: 2_500,
      provenance: "provider",
    });
    expect(detail.candidateCost.knownUsdMicros).toBe(0);

    const costs = getProjectCosts(testEnv.handle.db, projectId);
    expect(costs.totals.providerUsdMicros).toBe(2_500);
    expect(costs.totals.commitmentUsdMicros).toBe(2_500);
    expect(costs.byOperation).toEqual([
      expect.objectContaining({ operation: "segment", providerUsdMicros: 2_500 }),
      expect.objectContaining({ operation: "edit", providerUsdMicros: 0, calculatedUsdMicros: 0 }),
    ]);
  });
});

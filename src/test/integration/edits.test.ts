import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAssetBytes } from "@/lib/assets/store";
import type { AppEnv } from "@/lib/config/env";
import { getPricingConfig } from "@/lib/config/pricing";
import type { AssetUploadResponse, CostConsent } from "@/lib/contracts/api";
import { assets, runs, versions } from "@/lib/db/schema";
import { editReservationUsdMicros, enqueueEdit } from "@/lib/edits/service";
import { createEditHandler, type EditHandlerOptions } from "@/lib/jobs/handlers/edit";
import { createSegmentHandler } from "@/lib/jobs/handlers/segment";
import { runOnce } from "@/lib/jobs/worker";
import { decodeMaskPng } from "@/lib/images/mask-pipeline";
import { decodeRgb } from "@/lib/images/normalize";
import {
  createProject,
  getProjectSnapshot,
  importSample,
  importUploadedAsset,
  setActiveVersion,
} from "@/lib/projects/service";
import { enqueueRetry } from "@/lib/runs/retry";
import { getRunDetail } from "@/lib/runs/detail";
import { enqueueSegmentation } from "@/lib/segmentations/service";
import { getUsageEventByRunId } from "@/lib/usage/service";
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

async function sampleProject(): Promise<{ projectId: string; rootVersionId: string }> {
  const project = createProject(testEnv.handle.db, testEnv.env, "Edit");
  const imported = await importSample({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId: project.id,
    sampleId: "living-room-v1",
    idempotencyKey: randomUUID(),
  });
  const body = imported.body as { rootVersionId: string };
  return { projectId: project.id, rootVersionId: body.rootVersionId };
}

async function createSelection(
  projectId: string,
  sourceVersionId: string,
  positive = { x: 420, y: 610 },
): Promise<string> {
  const stored = await enqueueSegmentation({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId,
    sourceVersionId,
    positivePoints: [positive],
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
    throw new Error(`Selection for run ${(stored.body as { runId: string }).runId} was not created.`);
  }
  return selection.id;
}

async function uploadReference(projectId: string, bytes: Buffer): Promise<string> {
  const stored = await importUploadedAsset({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId,
    role: "reference",
    bytes,
    idempotencyKey: randomUUID(),
  });
  return (stored.body as AssetUploadResponse).assetId;
}

function enqueueEditFor(input: {
  projectId: string;
  parentVersionId: string;
  selectionId: string;
  references?: string[];
  instruction?: string;
  targetLabel?: string;
  env?: AppEnv;
  key?: string;
}) {
  const env = input.env ?? testEnv.env;
  return enqueueEdit({
    handle: testEnv.handle,
    env,
    projectId: input.projectId,
    parentVersionId: input.parentVersionId,
    selectionId: input.selectionId,
    paddingPx: 16,
    targetLabel: input.targetLabel ?? "sofa",
    instruction: input.instruction ?? "Make the sofa green.",
    referenceAssetIds: input.references ?? [],
    model: "openai/gpt-image-2.5-flare",
    costConsent: consent(editReservationUsdMicros(env)),
    idempotencyKey: input.key ?? randomUUID(),
  });
}

function runEdit(
  adapterFactory?: EditHandlerOptions["adapterFactory"],
  env: AppEnv = testEnv.env,
) {
  return runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env,
    handlers: { edit: createEditHandler({ adapterFactory }) },
  });
}

function imageAdapter(result: ImageGenerationResult): ImageEditAdapter {
  return { edit: async () => result };
}

describe("mock edit pipeline and immutable child versions", () => {
  it("composites the generated image exactly inside the allowed region and creates a child without switching active", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const stored = await enqueueEditFor({ projectId, parentVersionId: rootVersionId, selectionId });
    const runId = (stored.body as { runId: string }).runId;

    const worker = await runEdit();
    expect(worker).toEqual({ status: "handled", runId });

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(snapshot.project.activeVersionId).toBe(rootVersionId);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new Error("Edit run is missing.");
    expect(run).toMatchObject({
      kind: "edit",
      status: "succeeded",
      parentVersionId: rootVersionId,
      cost: { amountUsdMicros: 0, provenance: "calculated", outcome: "completed" },
    });
    const child = snapshot.versions.find((version) => version.id === run.outputVersionId);
    if (child === undefined) throw new Error("Child version is missing.");
    expect(child).toMatchObject({
      parentVersionId: rootVersionId,
      origin: "edit",
      originalAssetId: run.rawAssetId,
    });
    expect(child.sourceMetadata).toMatchObject({
      kind: "edit",
      parentVersionId: rootVersionId,
      selectionId,
      targetLabel: "sofa",
      instruction: "Make the sofa green.",
      referenceAssetIds: [],
    });

    const selection = snapshot.selections.find((candidate) => candidate.id === selectionId);
    if (selection === undefined) throw new Error("Selection is missing.");
    const allowedRow = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, selection.regions.variants["16"].allowedMaskAssetId))
      .get();
    if (allowedRow === undefined) throw new Error("Allowed mask is missing.");
    const allowed = await decodeMaskPng(
      await readAssetBytes(testEnv.env.assetDir, allowedRow.relativePath),
    );
    const allowedOn = allowed.mask.reduce((sum, value) => sum + value, 0);
    expect(run.metrics).toMatchObject({
      protectedPixelCount: 1024 * 1024 - allowedOn,
      finalBackgroundMae: 0,
      protectedMismatchPixels: 0,
    });
    expect(run.metrics?.rawBackgroundMae).toBeGreaterThan(0);

    const root = snapshot.versions.find((version) => version.id === rootVersionId);
    if (root === undefined) throw new Error("Root version is missing.");
    const rootAsset = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, root.imageAssetId))
      .get();
    const finalAsset = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, child.imageAssetId))
      .get();
    if (rootAsset === undefined || finalAsset === undefined) {
      throw new Error("Root or final asset is missing.");
    }
    expect(finalAsset.kind).toBe("final");
    const source = await decodeRgb(
      await readAssetBytes(testEnv.env.assetDir, rootAsset.relativePath),
    );
    const final = await decodeRgb(
      await readAssetBytes(testEnv.env.assetDir, finalAsset.relativePath),
    );
    expect(Array.from(final.data.subarray(0, 3))).toEqual(
      Array.from(source.data.subarray(0, 3)),
    );
    const pointOffset = (610 * 1024 + 420) * 3;
    expect(final.data[pointOffset]).toBe(((source.data[pointOffset] ?? 0) + 40) % 256);
    expect(final.data[pointOffset + 1]).toBe(source.data[pointOffset + 1]);
    expect(final.data[pointOffset + 2]).toBe(source.data[pointOffset + 2]);

    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      operation: "edit",
      provider: "mock",
      executionMode: "mock",
      outcome: "completed",
      amountUsdMicros: 0,
      costProvenance: "calculated",
    });

    const detail = getRunDetail(testEnv.handle.db, runId, testEnv.env);
    expect(detail.input).toMatchObject({
      kind: "edit",
      parentVersionId: rootVersionId,
      selectionId,
      paddingPx: 16,
      targetLabel: "sofa",
      instruction: "Make the sofa green.",
      referenceAssetIds: [],
    });
    if (detail.input?.kind !== "edit") throw new Error("Edit detail input is missing.");
    expect(detail.input.prompt).toContain("Image 1 is the source scene to edit.");
    expect(detail.input.prompt).toContain("No additional reference images were supplied.");
    expect(detail.input).not.toHaveProperty("providerReceiptJson");
  });

  it("preserves explicit reference order and allows two children from the same parent", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const firstReference = await uploadReference(
      projectId,
      await readFile("src/test/fixtures/synthetic/reference-sofa-v1.png"),
    );
    const secondReference = await uploadReference(
      projectId,
      await createTestImage({
        width: 1024,
        height: 1024,
        background: { r: 30, g: 180, b: 60 },
      }),
    );

    const first = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      references: [firstReference, secondReference],
    });
    await runEdit();
    const second = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      references: [secondReference, firstReference],
    });
    await runEdit();

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const firstRun = snapshot.runs.find(
      (candidate) => candidate.id === (first.body as { runId: string }).runId,
    );
    const secondRun = snapshot.runs.find(
      (candidate) => candidate.id === (second.body as { runId: string }).runId,
    );
    if (firstRun === undefined || secondRun === undefined) throw new Error("Edit runs are missing.");
    expect(firstRun.editInput?.referenceAssetIds).toEqual([firstReference, secondReference]);
    expect(secondRun.editInput?.referenceAssetIds).toEqual([secondReference, firstReference]);
    expect(snapshot.versions.filter((version) => version.parentVersionId === rootVersionId)).toHaveLength(2);
    expect(snapshot.project.activeVersionId).toBe(rootVersionId);

    const firstDetail = getRunDetail(testEnv.handle.db, firstRun.id, testEnv.env);
    if (firstDetail.input?.kind !== "edit") throw new Error("First edit detail is missing.");
    expect(firstDetail.input.prompt).toContain(
      "Images 2 and 3 are ordered user-supplied appearance references",
    );
    expect(firstDetail.input.referenceAssetIds).toEqual([firstReference, secondReference]);
  });

  it("rejects stale selections, invalid references and wrong project ownership", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const first = await enqueueEditFor({ projectId, parentVersionId: rootVersionId, selectionId });
    await runEdit();
    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const child = snapshot.versions.find(
      (version) => version.id === snapshot.runs.find(
        (run) => run.id === (first.body as { runId: string }).runId,
      )?.outputVersionId,
    );
    if (child === undefined) throw new Error("Child version is missing.");

    await expect(
      enqueueEditFor({ projectId, parentVersionId: child.id, selectionId }),
    ).rejects.toMatchObject({ code: "STALE_SELECTION" });

    const reference = await uploadReference(
      projectId,
      await readFile("src/test/fixtures/synthetic/reference-sofa-v1.png"),
    );
    const root = snapshot.versions.find((version) => version.id === rootVersionId);
    if (root === undefined) throw new Error("Root version is missing.");
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        references: [root.imageAssetId],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        references: [reference, reference],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        references: [reference, reference, reference],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const other = createProject(testEnv.handle.db, testEnv.env, "Other");
    await expect(
      enqueueEditFor({ projectId: other.id, parentVersionId: rootVersionId, selectionId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        instruction: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const liveWithoutKey = liveEnv({ openRouterApiKey: null });
    await expect(
      enqueueEditFor({
        projectId,
        parentVersionId: rootVersionId,
        selectionId,
        env: liveWithoutKey,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("branches from the root and from a child version without switching active on edit", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const rootSelection = await createSelection(projectId, rootVersionId);

    const first = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId: rootSelection,
      instruction: "Make the sofa green.",
    });
    await runEdit();
    const second = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId: rootSelection,
      instruction: "Make the sofa blue.",
    });
    await runEdit();

    let snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const firstRun = snapshot.runs.find(
      (run) => run.id === (first.body as { runId: string }).runId,
    );
    const secondRun = snapshot.runs.find(
      (run) => run.id === (second.body as { runId: string }).runId,
    );
    if (firstRun?.outputVersionId === null || firstRun?.outputVersionId === undefined) {
      throw new Error("First child is missing.");
    }
    if (secondRun?.outputVersionId === null || secondRun?.outputVersionId === undefined) {
      throw new Error("Second child is missing.");
    }
    expect(snapshot.project.activeVersionId).toBe(rootVersionId);
    expect(
      snapshot.versions.filter((version) => version.parentVersionId === rootVersionId),
    ).toHaveLength(2);

    setActiveVersion(testEnv.handle.db, projectId, firstRun.outputVersionId);
    const childSelection = await createSelection(projectId, firstRun.outputVersionId);
    const third = await enqueueEditFor({
      projectId,
      parentVersionId: firstRun.outputVersionId,
      selectionId: childSelection,
      instruction: "Make the child sofa green.",
    });
    await runEdit();
    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const thirdRun = snapshot.runs.find(
      (run) => run.id === (third.body as { runId: string }).runId,
    );
    if (thirdRun?.outputVersionId === null || thirdRun?.outputVersionId === undefined) {
      throw new Error("Grandchild is missing.");
    }
    const grandchild = snapshot.versions.find((version) => version.id === thirdRun.outputVersionId);
    expect(grandchild?.parentVersionId).toBe(firstRun.outputVersionId);
    expect(snapshot.project.activeVersionId).toBe(firstRun.outputVersionId);
    expect(
      snapshot.versions.filter((version) => version.parentVersionId === firstRun.outputVersionId),
    ).toHaveLength(1);
  });
  it("fails before provider dispatch when a mask asset row is missing", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const stored = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
    });
    const runId = (stored.body as { runId: string }).runId;
    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const selection = snapshot.selections.find((candidate) => candidate.id === selectionId);
    if (selection === undefined) throw new Error("Selection is missing.");
    testEnv.handle.db
      .delete(assets)
      .where(eq(assets.id, selection.regions.variants["16"].allowedMaskAssetId))
      .run();

    const worker = await runEdit(() => ({
      edit: async () => {
        throw new Error("The provider must not be called.");
      },
    }));
    expect(worker.status).toBe("handled");

    const storedRun = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(storedRun).toMatchObject({
      status: "failed",
      errorCode: "INVALID_RUN_STATE",
      providerStartedAt: null,
      budgetChargeUsdMicros: 0,
    });
    expect(getUsageEventByRunId(testEnv.handle.db, runId)).toBeUndefined();
  });
});

describe("live edit cost, failure and recovery paths", () => {
  async function liveEditSetup() {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);
    const env = liveEnv();
    return { projectId, rootVersionId, selectionId, env };
  }

  it("uses provider-reported cost when present and the reservation as estimated otherwise", async () => {
    const { projectId, rootVersionId, selectionId, env } = await liveEditSetup();
    const generated = await createTestImage({
      width: 1024,
      height: 1024,
      background: { r: 80, g: 90, b: 100 },
    });

    const observed = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    await runEdit(
      () =>
        imageAdapter({
          kind: "image",
          bytes: generated,
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          providerRequestId: "req_edit_observed",
          observedCostUsdMicros: 123456,
          usage: { cost: 0.123456 },
          latencyMs: 40,
        }),
      env,
    );
    let usage = getUsageEventByRunId(
      testEnv.handle.db,
      (observed.body as { runId: string }).runId,
    );
    expect(usage).toMatchObject({
      provider: "openrouter",
      executionMode: "live",
      amountUsdMicros: 123456,
      costProvenance: "provider",
    });

    const estimated = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    await runEdit(
      () =>
        imageAdapter({
          kind: "image",
          bytes: generated,
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          providerRequestId: "req_edit_estimated",
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 30,
        }),
      env,
    );
    usage = getUsageEventByRunId(testEnv.handle.db, (estimated.body as { runId: string }).runId);
    expect(usage).toMatchObject({
      amountUsdMicros: 250000,
      costProvenance: "estimated",
    });
  });

  it("settles definitive rejection, ambiguity and invalid output with explicit retry states", async () => {
    const { projectId, rootVersionId, selectionId, env } = await liveEditSetup();
    const generated = await createTestImage({
      width: 1024,
      height: 1024,
      background: { r: 40, g: 50, b: 60 },
    });

    const rejected = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    await runEdit(
      () =>
        imageAdapter({
          kind: "rejected",
          message: "OpenRouter rejected the request (HTTP 400).",
          httpStatus: 400,
          providerRequestId: null,
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 10,
        }),
      env,
    );
    const rejectedRunId = (rejected.body as { runId: string }).runId;
    let snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.runs.find((run) => run.id === rejectedRunId)).toMatchObject({
      status: "failed",
      errorCode: "PROVIDER_REJECTED",
      retryMode: "provider",
      cost: { amountUsdMicros: 0, provenance: "calculated", outcome: "rejected" },
    });

    const ambiguous = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    await runEdit(
      () =>
        imageAdapter({
          kind: "ambiguous",
          message: "OpenRouter request timed out before a definitive response.",
          providerRequestId: null,
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: null,
        }),
      env,
    );
    const ambiguousRunId = (ambiguous.body as { runId: string }).runId;
    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.runs.find((run) => run.id === ambiguousRunId)).toMatchObject({
      status: "needs_review",
      errorCode: "INTERRUPTED",
      retryMode: "provider",
      cost: { amountUsdMicros: null, provenance: "unavailable", outcome: "unknown" },
    });

    const invalid = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      env,
    });
    await runEdit(
      () =>
        imageAdapter({
          kind: "invalid",
          message: "Provider returned an unusable image.",
          httpStatus: 200,
          bytes: generated,
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          providerRequestId: "req_invalid",
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 20,
        }),
      env,
    );
    const invalidRunId = (invalid.body as { runId: string }).runId;
    snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    const invalidRun = snapshot.runs.find((run) => run.id === invalidRunId);
    expect(invalidRun).toMatchObject({
      status: "failed",
      errorCode: "INVALID_PROVIDER_OUTPUT",
      retryMode: "provider",
    });
    expect(invalidRun?.rawAssetId).not.toBeNull();
    expect(invalidRun?.outputVersionId).toBeNull();
  });

  it("retries local compositing from a receipt and provider failures as a new run", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const selectionId = await createSelection(projectId, rootVersionId);

    const successful = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
    });
    await runEdit();
    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const successfulRun = snapshot.runs.find(
      (run) => run.id === (successful.body as { runId: string }).runId,
    );
    if (successfulRun?.rawAssetId === null || successfulRun?.rawAssetId === undefined) {
      throw new Error("Successful raw asset is missing.");
    }

    const local = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      instruction: "Make the sofa teal.",
    });
    const localRunId = (local.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({
        status: "failed",
        stage: "error",
        providerStartedAt: Date.now(),
        providerReceiptJson: {
          kind: "image",
          complete: true,
          rawAssetId: successfulRun.rawAssetId,
          responseMetadata: { nativeWidth: 1024, nativeHeight: 1024 },
        },
        rawAssetId: successfulRun.rawAssetId,
        errorCode: "LOCAL_PROCESSING_FAILED",
        errorMessage: "Local edit processing failed.",
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, localRunId))
      .run();

    const retried = await enqueueRetry({
      handle: testEnv.handle,
      env: testEnv.env,
      runId: localRunId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: false,
      idempotencyKey: randomUUID(),
    });
    expect((retried.body as { runId: string }).runId).toBe(localRunId);
    await runEdit();
    const afterLocal = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(afterLocal.runs.find((run) => run.id === localRunId)?.status).toBe("succeeded");
    expect(
      testEnv.handle.db
        .select()
        .from(versions)
        .where(eq(versions.originatingRunId, localRunId))
        .all(),
    ).toHaveLength(1);

    const provider = await enqueueEditFor({
      projectId,
      parentVersionId: rootVersionId,
      selectionId,
      instruction: "Make the sofa yellow.",
    });
    const providerRunId = (provider.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({
        status: "failed",
        stage: "error",
        providerStartedAt: Date.now(),
        errorCode: "PROVIDER_REJECTED",
        errorMessage: "Provider rejected the edit.",
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, providerRunId))
      .run();

    const providerRetry = await enqueueRetry({
      handle: testEnv.handle,
      env: testEnv.env,
      runId: providerRunId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: true,
      idempotencyKey: randomUUID(),
    });
    const newRunId = (providerRetry.body as { runId: string }).runId;
    expect(newRunId).not.toBe(providerRunId);
    await runEdit();
    const afterProvider = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(afterProvider.runs.find((run) => run.id === newRunId)?.status).toBe("succeeded");
  });
});

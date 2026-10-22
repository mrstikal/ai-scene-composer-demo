import { randomUUID } from "node:crypto";

import { parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAssetBytes } from "@/lib/assets/store";
import type { AppEnv } from "@/lib/config/env";
import { getPricingConfig } from "@/lib/config/pricing";
import type { CostConsent } from "@/lib/contracts/api";
import type { SamMaskRecord } from "@/lib/contracts/domain";
import { assets, runs, selections, usageEvents } from "@/lib/db/schema";
import {
  createSegmentHandler,
  type SegmentHandlerOptions,
} from "@/lib/jobs/handlers/segment";
import { recoverRunningRuns } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";
import { decodeAlphaPng, decodeMaskPng } from "@/lib/images/mask-pipeline";
import { buildMockMask } from "@/lib/providers/mocks";
import { createProject, getProjectSnapshot, importSample } from "@/lib/projects/service";
import { enqueueRetry } from "@/lib/runs/retry";
import { getRunDetail } from "@/lib/runs/detail";
import {
  enqueueSegmentation,
  segmentationReservationUsdMicros,
} from "@/lib/segmentations/service";
import { getUsageEventByRunId } from "@/lib/usage/service";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";
import documented from "@/test/fixtures/providers/sam/documented-complete-output-line.json";

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

async function sampleProject(): Promise<{ projectId: string; rootVersionId: string }> {
  const project = createProject(testEnv.handle.db, testEnv.env, "Selection");
  const imported = await importSample({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId: project.id,
    sampleId: "living-room-v1",
    idempotencyKey: randomUUID(),
  });
  const body = imported.body as { rootVersionId: string; assetId: string };
  return { projectId: project.id, rootVersionId: body.rootVersionId };
}

async function enqueue(
  projectId: string,
  sourceVersionId: string,
  positive: { x: number; y: number },
  options: {
    negative?: { x: number; y: number }[];
    env?: AppEnv;
    reservation?: number;
    key?: string;
  } = {},
) {
  const env = options.env ?? testEnv.env;
  return enqueueSegmentation({
    handle: testEnv.handle,
    env,
    projectId,
    sourceVersionId,
    positivePoints: [positive],
    negativePoints: options.negative ?? [],
    costConsent: consent(
      options.reservation ?? segmentationReservationUsdMicros(env),
    ),
    idempotencyKey: options.key ?? randomUUID(),
  });
}

function runSegment(
  adapterFactory?: SegmentHandlerOptions["adapterFactory"],
  env: AppEnv = testEnv.env,
) {
  return runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env,
    handlers: { segment: createSegmentHandler({ adapterFactory }) },
  });
}

function liveEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...testEnv.env,
    aiMode: "live",
    samMode: "live",
    metaModelApiKey: "test-meta-key",
    ...overrides,
  };
}

async function* eventStream(events: readonly ResponsesEvent[]): AsyncIterable<ResponsesEvent> {
  for (const event of events) yield event;
}

async function documentedObjectOneRecord(): Promise<SamMaskRecord> {
  const outputText = documented.outputText;
  const split = outputText.indexOf(",1<|box");
  const events: ResponsesEvent[] = [
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(0, split),
    },
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(split),
    },
    {
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    },
    { type: "response.completed" },
  ];
  const result = await parseImageStream(eventStream(events)).finalResult;
  const mask = recordsOfKind(result.records, "mask").find((record) => record.objectId === "1");
  const box = recordsOfKind(result.records, "box").find((record) => record.objectId === "1");
  if (mask === undefined || box === undefined) throw new Error("Documented object is missing.");
  return {
    objectId: "1",
    box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
    bounds: {
      left: mask.bounds.left,
      top: mask.bounds.top,
      right: mask.bounds.right,
      bottom: mask.bounds.bottom,
    },
    mask: {
      encoding: mask.mask.encoding,
      payload: mask.mask.payload,
      width: mask.mask.width,
      height: mask.mask.height,
    },
  };
}

describe("SAM selection enqueue and mock worker", () => {
  it("persists an immutable selection, both exact region variants and a zero-cost usage event", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const positive = { x: 420, y: 610 };
    const stored = await enqueue(projectId, rootVersionId, positive);
    expect(stored.status).toBe(202);
    const runId = (stored.body as { runId: string }).runId;

    const worker = await runSegment();
    expect(worker).toEqual({ status: "handled", runId });

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(snapshot.selections).toHaveLength(1);
    const selection = snapshot.selections[0];
    if (selection === undefined) throw new Error("Selection was not persisted.");
    expect(selection.sourceVersionId).toBe(rootVersionId);
    expect(selection.positivePoints).toEqual([positive]);
    expect(selection.negativePoints).toEqual([]);
    expect(selection.regions.pipelineVersion).toBe("mask-pipeline-v1");
    expect(selection.regions.featherPx).toBe(8);
    expect(selection.regions.paddingPx).toEqual([16, 32]);
    expect(snapshot.pricing.reservations.segmentationUsdMicros).toBe(0);

    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      kind: "segment",
      status: "succeeded",
      stage: "done",
      parentVersionId: rootVersionId,
      outputSelectionId: selection.id,
      segmentInput: {
        sourceVersionId: rootVersionId,
        positivePoints: [positive],
        negativePoints: [],
      },
      retryMode: "none",
      cost: { reservedUsdMicros: 0, budgetChargeUsdMicros: 0 },
    });

    const assetRows = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.projectId, projectId))
      .all();
    const maskRow = assetRows.find((asset) => asset.id === selection.binaryMaskAssetId);
    expect(maskRow?.kind).toBe("selection_mask");
    expect(assetRows.filter((asset) => asset.kind === "selection_mask")).toHaveLength(1);
    const storedRun = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(storedRun?.providerReceiptJson).toMatchObject({
      representation: "full-mask-asset",
      binaryMaskAssetId: selection.binaryMaskAssetId,
    });
    if (maskRow === undefined) throw new Error("Selection mask asset is missing.");
    const decoded = await decodeMaskPng(
      await readAssetBytes(testEnv.env.assetDir, maskRow.relativePath),
    );
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(1024);
    const at = (x: number, y: number) => decoded.mask[y * 1024 + x];
    expect(at(420, 610)).toBe(1);
    expect(at(356, 610)).toBe(1);
    expect(at(355, 610)).toBe(0);
    expect(at(484, 610)).toBe(1);
    expect(at(485, 610)).toBe(0);
    expect(at(420, 546)).toBe(1);
    expect(at(420, 545)).toBe(0);
    expect(at(420, 674)).toBe(1);
    expect(at(420, 675)).toBe(0);

    const variant16 = selection.regions.variants["16"];
    expect(variant16.boundingBox).toEqual({ left: 340, top: 530, right: 501, bottom: 691 });
    expect(variant16.percentages).toEqual({
      left: 33.2,
      top: 51.8,
      right: 48.9,
      bottom: 67.5,
    });
    expect(selection.regions.variants["32"].boundingBox).toEqual({
      left: 324,
      top: 514,
      right: 517,
      bottom: 707,
    });

    const allowedRow = assetRows.find((asset) => asset.id === variant16.allowedMaskAssetId);
    expect(allowedRow?.kind).toBe("allowed_mask");
    expect(allowedRow?.sha256).toBe(variant16.allowedMaskSha256);
    if (allowedRow === undefined) throw new Error("Allowed mask asset is missing.");
    const allowed = await decodeMaskPng(
      await readAssetBytes(testEnv.env.assetDir, allowedRow.relativePath),
    );
    expect(allowed.mask[610 * 1024 + 340]).toBe(1);
    expect(allowed.mask[610 * 1024 + 339]).toBe(0);
    expect(allowed.mask[610 * 1024 + 500]).toBe(1);
    expect(allowed.mask[610 * 1024 + 501]).toBe(0);

    const blendRow = assetRows.find((asset) => asset.id === variant16.blendMaskAssetId);
    expect(blendRow?.kind).toBe("blend_mask");
    expect(blendRow?.sha256).toBe(variant16.blendMaskSha256);
    if (blendRow === undefined) throw new Error("Blend mask asset is missing.");
    const blend = await decodeAlphaPng(
      await readAssetBytes(testEnv.env.assetDir, blendRow.relativePath),
    );
    expect(blend.alpha[610 * 1024 + 420]).toBe(255);
    expect(blend.alpha[610 * 1024 + 340]).toBe(0);
    expect(blend.alpha[610 * 1024 + 341]).toBe(32);

    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      operation: "segment",
      provider: "mock",
      executionMode: "mock",
      outcome: "completed",
      amountUsdMicros: 0,
      costProvenance: "calculated",
      providerRequestId: null,
    });

    const detail = getRunDetail(testEnv.handle.db, runId, testEnv.env);
    expect(detail.input).toMatchObject({
      kind: "segment",
      sourceVersionId: rootVersionId,
      width: 1024,
      height: 1024,
      positivePoints: [positive],
      negativePoints: [],
    });
    expect(detail.input).not.toHaveProperty("records");
  });

  it("creates a new immutable selection for a negative correction without mutating the first", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const firstStored = await enqueue(projectId, rootVersionId, { x: 420, y: 610 });
    await runSegment();
    const firstSnapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    const first = firstSnapshot.selections[0];
    if (first === undefined) throw new Error("First selection is missing.");
    const firstMaskRow = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, first.binaryMaskAssetId))
      .get();
    const firstHash = firstMaskRow?.sha256;

    const secondStored = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, {
      negative: [{ x: 420, y: 620 }],
    });
    expect((secondStored.body as { runId: string }).runId).not.toBe(
      (firstStored.body as { runId: string }).runId,
    );
    await runSegment();

    const after = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(after.selections).toHaveLength(2);
    expect(after.selections[0]).toEqual(first);
    const second = after.selections[1];
    if (second === undefined) throw new Error("Second selection is missing.");
    expect(second.id).not.toBe(first.id);
    expect(second.negativePoints).toEqual([{ x: 420, y: 620 }]);

    const secondMaskRow = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, second.binaryMaskAssetId))
      .get();
    if (secondMaskRow === undefined) throw new Error("Second mask is missing.");
    const secondMask = await decodeMaskPng(
      await readAssetBytes(testEnv.env.assetDir, secondMaskRow.relativePath),
    );
    expect(secondMask.mask[610 * 1024 + 420]).toBe(1);
    expect(secondMask.mask[620 * 1024 + 420]).toBe(0);

    const firstMaskAfter = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.id, first.binaryMaskAssetId))
      .get();
    expect(firstMaskAfter?.sha256).toBe(firstHash);
    expect(after.runs.filter((run) => run.kind === "segment")).toHaveLength(2);
  });

  it("replays the same idempotency key and does not create a second run", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const key = randomUUID();
    const first = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { key });
    const second = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { key });
    expect(second).toEqual(first);
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.projectId, projectId)).all(),
    ).toHaveLength(1);
  });

  it("conflicts when the same key is replayed with different cost consent", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const key = randomUUID();
    await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { key });

    await expect(
      enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { key, reservation: 1 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("validates point counts, ranges, identity and source ownership before enqueue", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const other = createProject(testEnv.handle.db, testEnv.env, "Other");

    await expect(
      enqueue(projectId, rootVersionId, { x: 10, y: 10 }, {
        negative: [{ x: 10, y: 10 }],
      }),
    ).rejects.toThrow("must differ");

    await expect(
      enqueue(projectId, rootVersionId, { x: 1024, y: 0 }),
    ).rejects.toThrow("inside the canonical image");

    await expect(
      enqueueSegmentation({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId,
        sourceVersionId: rootVersionId,
        positivePoints: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        negativePoints: [],
        costConsent: consent(0),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("Exactly one positive point");

    await expect(enqueue(other.id, rootVersionId, { x: 10, y: 10 })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.projectId, projectId)).all(),
    ).toHaveLength(0);
  });

  it("rejects fixture mode before creating a run when no authentic capture exists", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv({ samMode: "fixture", metaModelApiKey: null });

    await expect(enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { env })).rejects.toMatchObject(
      { status: 503, code: "PROVIDER_UNAVAILABLE" },
    );
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.projectId, projectId)).all(),
    ).toHaveLength(0);
    expect(
      testEnv.handle.db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.projectId, projectId))
        .all(),
    ).toHaveLength(0);
  });

  it("rejects live mode before creating a run when the Meta key is missing", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv({ metaModelApiKey: null });

    await expect(enqueue(projectId, rootVersionId, { x: 420, y: 610 }, { env })).rejects.toMatchObject(
      { status: 503, code: "PROVIDER_UNAVAILABLE" },
    );
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.projectId, projectId)).all(),
    ).toHaveLength(0);
  });
});

describe("live SAM cost and failure settlement", () => {
  it("charges the calculated completed-image rate when live SAM omits provider cost", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv();
    const positive = { x: 420, y: 610 };
    const stored = await enqueue(projectId, rootVersionId, positive, {
      env,
      reservation: 2500,
    });
    const runId = (stored.body as { runId: string }).runId;

    const fullMask = buildMockMask({ positive, negative: null });
    await runSegment(
      () => ({
        segment: async () => ({
          kind: "mask",
          representation: "full-mask",
          fullMask,
          width: 1024,
          height: 1024,
          providerRequestId: "req_live",
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 25,
        }),
      }),
      env,
    );

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.selections).toHaveLength(1);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      status: "succeeded",
      executionMode: "live",
      cost: { reservedUsdMicros: 2500, budgetChargeUsdMicros: 2500 },
    });
    const runRow = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(runRow?.inputSnapshotJson).toMatchObject({ calculatedCostUsdMicros: 2500 });
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      operation: "segment",
      provider: "meta",
      executionMode: "live",
      outcome: "completed",
      amountUsdMicros: 2500,
      costProvenance: "calculated",
      providerRequestId: "req_live",
      elapsedMs: 25,
    });
    expect(usage?.pricingSourceSnapshotJson).toMatchObject({
      reservationUsdMicros: 2500,
      calculatedCostUsdMicros: 2500,
    });
  });

  it("freezes a cost for legacy queued snapshots that predate the stored rate", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv();
    const positive = { x: 420, y: 610 };
    const stored = await enqueue(projectId, rootVersionId, positive, {
      env,
      reservation: 2500,
    });
    const runId = (stored.body as { runId: string }).runId;
    const runRow = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    const legacySnapshot = {
      ...(runRow?.inputSnapshotJson as Record<string, unknown>),
    };
    delete legacySnapshot.calculatedCostUsdMicros;
    testEnv.handle.db
      .update(runs)
      .set({ inputSnapshotJson: legacySnapshot })
      .where(eq(runs.id, runId))
      .run();

    const fullMask = buildMockMask({ positive, negative: null });
    await runSegment(
      () => ({
        segment: async () => ({
          kind: "mask",
          representation: "full-mask",
          fullMask,
          width: 1024,
          height: 1024,
          providerRequestId: "req_legacy",
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 25,
        }),
      }),
      env,
    );

    const updated = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(updated?.status).toBe("succeeded");
    expect(updated?.inputSnapshotJson).toMatchObject({ calculatedCostUsdMicros: 2500 });
  });

  it("charges a completed response even when the returned mask is invalid", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv();
    const stored = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, {
      env,
      reservation: 2500,
    });
    const runId = (stored.body as { runId: string }).runId;

    await runSegment(
      () => ({
        segment: async () => ({
          kind: "invalid",
          message: "The positive point is not covered by the SAM mask.",
          httpStatus: null,
          providerRequestId: "req_invalid",
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 20,
        }),
      }),
      env,
    );

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    expect(snapshot.selections).toEqual([]);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "INVALID_SELECTION",
      retryMode: "provider",
      retryReservationUsdMicros: 2500,
      cost: { reservedUsdMicros: 2500, budgetChargeUsdMicros: 2500 },
    });
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      outcome: "completed",
      amountUsdMicros: 2500,
      costProvenance: "calculated",
    });
  });

  it("retains the reservation as a hold when a definitive rejection reports no cost", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv();
    const stored = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, {
      env,
      reservation: 2500,
    });
    const runId = (stored.body as { runId: string }).runId;

    await runSegment(
      () => ({
        segment: async () => ({
          kind: "rejected",
          message: "Meta SAM rejected the request (HTTP 400).",
          httpStatus: 400,
          providerRequestId: null,
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: 10,
        }),
      }),
      env,
    );

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "PROVIDER_REJECTED",
      retryMode: "provider",
      cost: { reservedUsdMicros: 2500, budgetChargeUsdMicros: 2500 },
    });
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      outcome: "rejected",
      amountUsdMicros: null,
      costProvenance: "unavailable",
    });
  });

  it("marks an ambiguous timeout as unknown with the reservation held", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const env = liveEnv();
    const stored = await enqueue(projectId, rootVersionId, { x: 420, y: 610 }, {
      env,
      reservation: 2500,
    });
    const runId = (stored.body as { runId: string }).runId;

    await runSegment(
      () => ({
        segment: async () => ({
          kind: "ambiguous",
          message: "Meta SAM request timed out before a definitive response.",
          errorCode: "PROVIDER_TIMEOUT",
          providerRequestId: null,
          observedCostUsdMicros: null,
          usage: null,
          latencyMs: null,
        }),
      }),
      env,
    );

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, env);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      status: "needs_review",
      errorCode: "PROVIDER_TIMEOUT",
      retryMode: "provider",
      cost: { reservedUsdMicros: 2500, budgetChargeUsdMicros: 2500 },
    });
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage).toMatchObject({
      outcome: "unknown",
      amountUsdMicros: null,
      costProvenance: "unavailable",
    });
  });
});

describe("SAM receipt recovery and local retry", () => {
  async function failedRunWithReceipt(projectId: string, rootVersionId: string) {
    const stored = await enqueue(projectId, rootVersionId, { x: 180, y: 240 });
    const runId = (stored.body as { runId: string }).runId;
    const queued = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (queued === undefined) throw new Error("Queued run is missing.");
    const receipt = {
      kind: "segment" as const,
      representation: "sam-records" as const,
      complete: true as const,
      records: [await documentedObjectOneRecord()],
      responseMetadata: {},
    };

    testEnv.handle.db
      .update(runs)
      .set({
        status: "failed",
        stage: "error",
        providerStartedAt: Date.now(),
        providerReceiptJson: receipt,
        errorCode: "LOCAL_PROCESSING_FAILED",
        errorMessage: "Local selection processing failed.",
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, runId))
      .run();

    return { runId, receipt };
  }

  it("recovers a dispatched run from a complete SAM receipt without a new provider call", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const { runId } = await failedRunWithReceipt(projectId, rootVersionId);

    testEnv.handle.db
      .update(runs)
      .set({
        status: "running",
        stage: "calling_provider",
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(runs.id, runId))
      .run();

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const recovered = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(recovered?.status).toBe("queued");
    expect(recovered?.stage).toBe("processing");

    const worker = await runSegment();
    expect(worker).toEqual({ status: "handled", runId });

    const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
    expect(snapshot.selections).toHaveLength(1);
    expect(snapshot.selections[0]?.positivePoints).toEqual([{ x: 180, y: 240 }]);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    expect(run).toMatchObject({
      status: "succeeded",
      outputSelectionId: snapshot.selections[0]?.id,
    });
  });

  it("retries local mask processing on the same run and keeps the settled charge", async () => {
    const { projectId, rootVersionId } = await sampleProject();
    const { runId } = await failedRunWithReceipt(projectId, rootVersionId);

    const retried = await enqueueRetry({
      handle: testEnv.handle,
      env: testEnv.env,
      runId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: false,
      idempotencyKey: randomUUID(),
    });
    expect(retried.status).toBe(202);
    expect((retried.body as { runId: string }).runId).toBe(runId);

    const worker = await runSegment();
    expect(worker).toEqual({ status: "handled", runId });
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("succeeded");
    expect(
      testEnv.handle.db
        .select()
        .from(selections)
        .where(eq(selections.originatingRunId, runId))
        .all(),
    ).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CostConsent, GenerationInput } from "@/lib/contracts/api";
import { getPricingConfig } from "@/lib/config/pricing";
import { writeAssetBytes } from "@/lib/assets/store";
import { assets, projects, runs, usageEvents, versions } from "@/lib/db/schema";
import { buildGenerationSnapshot, enqueueGeneration, resolveGenerationPrompt } from "@/lib/generations/service";
import { createGenerateHandler, type GenerateHandlerOptions } from "@/lib/jobs/handlers/generate";
import { recoverRunningRuns } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";
import { createProject, getProjectSnapshot, importSample } from "@/lib/projects/service";
import { getRunDetail } from "@/lib/runs/detail";
import { enqueueRetry } from "@/lib/runs/retry";
import { createPendingUsageEvent, getUsageEventByRunId, settleUsageEvent } from "@/lib/usage/service";
import type { ImageGenerationResult } from "@/lib/providers/types";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";
import { insertAssetRow, insertRun } from "@/test/helpers/domain";

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

async function enqueue(
  projectId: string,
  input: GenerationInput,
  options: { key?: string; reservation?: number; env?: TestEnvironment["env"] } = {},
) {
  return enqueueGeneration({
    handle: testEnv.handle,
    env: options.env ?? testEnv.env,
    projectId,
    generationInput: input,
    costConsent: consent(options.reservation ?? 0),
    idempotencyKey: options.key ?? randomUUID(),
  });
}

function runGeneration(
  adapterFactory?: GenerateHandlerOptions["adapterFactory"],
  env: TestEnvironment["env"] = testEnv.env,
) {
  return runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env,
    handlers: { generate: createGenerateHandler({ adapterFactory }) },
  });
}

async function imageResult(observedCostUsdMicros: number | null): Promise<ImageGenerationResult> {
  const bytes = await readFile(
    join(process.cwd(), "src/test/fixtures/synthetic/living-room-v1.png"),
  );
  return {
    kind: "image",
    bytes,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    providerRequestId: "req_live",
    usage:
      observedCostUsdMicros === null ? null : { cost: observedCostUsdMicros / 1_000_000 },
    observedCostUsdMicros,
    latencyMs: 12,
  };
}

function installManualRoot(projectId: string): string {
  const asset = insertAssetRow(testEnv.handle.db, projectId, { kind: "canonical" });
  const versionId = randomUUID();
  const now = Date.now();
  testEnv.handle.db
    .insert(versions)
    .values({
      id: versionId,
      projectId,
      parentVersionId: null,
      imageAssetId: asset.id,
      origin: "upload",
      originalAssetId: null,
      sourceMetadataJson: null,
      originatingRunId: null,
      createdAt: now,
    })
    .run();
  testEnv.handle.db
    .update(projects)
    .set({ rootVersionId: versionId, activeVersionId: versionId })
    .where(eq(projects.id, projectId))
    .run();
  return versionId;
}

describe("generation enqueue and mock worker", () => {
  it("runs all three presets and a custom prompt to canonical roots", async () => {
    const inputs: GenerationInput[] = [
      { mode: "preset", presetId: "cozy-living-room" },
      { mode: "preset", presetId: "scandinavian-dining-room" },
      { mode: "preset", presetId: "minimalist-bedroom" },
      { mode: "custom", prompt: "A sunlit study with a blue armchair and a wooden desk." },
    ];

    for (const input of inputs) {
      const project = createProject(testEnv.handle.db, testEnv.env, "Generated");
      const stored = await enqueue(project.id, input);
      expect(stored.status).toBe(202);
      const runId = (stored.body as { runId: string }).runId;

      const pending = getProjectSnapshot(testEnv.handle.db, project.id);
      expect(pending.runs).toHaveLength(1);
      expect(pending.runs[0]?.status).toBe("queued");
      expect(pending.runs[0]?.inputSummary?.mode).toBe(input.mode);

      const result = await runGeneration();
      expect(result).toEqual({ status: "handled", runId });

      const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
      expect(snapshot.project.rootVersionId).not.toBeNull();
      expect(snapshot.project.activeVersionId).toBe(snapshot.project.rootVersionId);
      expect(snapshot.versions).toHaveLength(1);
      expect(snapshot.versions[0]?.origin).toBe("generate");
      expect(snapshot.runs[0]?.status).toBe("succeeded");
      expect(snapshot.runs[0]?.cost.budgetChargeUsdMicros).toBe(0);

      const version = snapshot.versions[0];
      expect(version?.sourceMetadata).toMatchObject({ kind: "generation", mode: input.mode });
      const canonicalAsset = testEnv.handle.db
        .select()
        .from(assets)
        .where(eq(assets.id, version?.imageAssetId ?? ""))
        .get();
      expect(canonicalAsset?.width).toBe(1024);
      expect(canonicalAsset?.height).toBe(1024);

      const usage = getUsageEventByRunId(testEnv.handle.db, runId);
      expect(usage?.outcome).toBe("completed");
      expect(usage?.amountUsdMicros).toBe(0);
      expect(usage?.costProvenance).toBe("calculated");
      expect(usage?.executionMode).toBe("mock");

      const storedRun = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
      expect(storedRun?.inputSnapshotJson).toMatchObject({ mode: input.mode, prompt: expect.any(String) });
    }
  });

  it("keeps the full custom prompt out of project summaries and exposes it on demand", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Prompt Detail");
    const prompt = "A private custom prompt with a blue armchair and a wooden desk.";
    const queued = await enqueue(project.id, { mode: "custom", prompt });
    const runId = (queued.body as { runId: string }).runId;

    const summary = JSON.stringify(getProjectSnapshot(testEnv.handle.db, project.id));
    expect(summary).not.toContain(prompt);
    expect(summary).not.toContain("inputSnapshot");
    expect(summary).not.toContain("providerReceipt");

    const detail = getRunDetail(testEnv.handle.db, runId);
    expect(detail.input).toMatchObject({ mode: "custom", prompt });
    expect(detail.usage).toBeNull();
  });

  it("replays the same idempotency key and rejects a second generation while queued", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Idempotent");
    const key = randomUUID();
    const first = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" }, { key });
    const replay = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" }, { key });
    expect(replay).toEqual(first);

    await expect(
      enqueue(project.id, { mode: "preset", presetId: "minimalist-bedroom" }),
    ).rejects.toThrow("The project is already initializing a root scene.");
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.projectId, project.id)).all(),
    ).toHaveLength(1);
  });

  it("rejects generation when a root already exists", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Rooted");
    await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: randomUUID(),
    });

    await expect(
      enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" }),
    ).rejects.toThrow("This project already has a root scene.");
  });

  it("rejects stale consent and unconfigured live providers", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Consent");
    await expect(
      enqueueGeneration({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId: project.id,
        generationInput: { mode: "preset", presetId: "cozy-living-room" },
        costConsent: { ...consent(0), pricingVersion: "2020-01-01-v1" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("The pricing version changed.");

    await expect(
      enqueueGeneration({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId: project.id,
        generationInput: { mode: "preset", presetId: "cozy-living-room" },
        costConsent: consent(1),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("The reservation changed.");

    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: null };
    await expect(
      enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" }, {
        env: liveEnv,
        reservation: 250_000,
      }),
    ).rejects.toThrow("OpenRouter is not configured.");
  });

  it("rejects a live reservation above the project cap", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Budget");
    testEnv.handle.db
      .update(projects)
      .set({ budgetLimitUsdMicros: 1000 })
      .where(eq(projects.id, project.id))
      .run();
    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: "test-key" };

    await expect(
      enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" }, {
        env: liveEnv,
        reservation: 250_000,
      }),
    ).rejects.toThrow("The project budget would be exceeded.");
  });
});

describe("generation failure, conflict and retry", () => {
  it("persists a definitive rejection, keeps the project empty and retries as a new run", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Rejected");
    const first = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const firstRunId = (first.body as { runId: string }).runId;

    const rejectedAdapter = {
      generate: async (): Promise<ImageGenerationResult> => ({
        kind: "rejected",
        message: "OpenRouter rejected the request (HTTP 400).",
        httpStatus: 400,
        providerRequestId: "req_rejected",
        usage: null,
        observedCostUsdMicros: null,
        latencyMs: 5,
      }),
    };
    await runGeneration(() => rejectedAdapter);

    const failed = testEnv.handle.db.select().from(runs).where(eq(runs.id, firstRunId)).get();
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("PROVIDER_REJECTED");
    expect(failed?.outputVersionId).toBeNull();
    expect(getProjectSnapshot(testEnv.handle.db, project.id).versions).toEqual([]);
    const usage = getUsageEventByRunId(testEnv.handle.db, firstRunId);
    expect(usage?.outcome).toBe("rejected");
    expect(usage?.amountUsdMicros).toBe(0);
    expect(usage?.costProvenance).toBe("calculated");

    const retry = await enqueueRetry({
      handle: testEnv.handle,
      env: testEnv.env,
      runId: firstRunId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: true,
      idempotencyKey: randomUUID(),
    });
    const retryRunId = (retry.body as { runId: string }).runId;
    expect(retryRunId).not.toBe(firstRunId);
    const retryRun = testEnv.handle.db.select().from(runs).where(eq(runs.id, retryRunId)).get();
    expect(retryRun?.retryOfRunId).toBe(firstRunId);
    expect(retryRun?.status).toBe("queued");

    await runGeneration();
    expect(getProjectSnapshot(testEnv.handle.db, project.id).project.rootVersionId).not.toBeNull();
  });

  it("marks an ambiguous outcome for review and requires duplicate-charge acknowledgement", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Ambiguous");
    const first = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (first.body as { runId: string }).runId;

    const ambiguousAdapter = {
      generate: async (): Promise<ImageGenerationResult> => ({
        kind: "ambiguous",
        message: "Network failed.",
        providerRequestId: null,
        usage: null,
        observedCostUsdMicros: null,
        latencyMs: 10,
      }),
    };
    await runGeneration(() => ambiguousAdapter);

    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(stored?.status).toBe("needs_review");
    expect(stored?.errorCode).toBe("INTERRUPTED");
    expect(stored?.budgetChargeUsdMicros).toBe(0);
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage?.outcome).toBe("unknown");
    expect(usage?.amountUsdMicros).toBeNull();
    expect(usage?.costProvenance).toBe("unavailable");

    await expect(
      enqueueRetry({
        handle: testEnv.handle,
        env: testEnv.env,
        runId,
        costConsent: consent(0),
        acknowledgePossibleDuplicateCharge: false,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("Acknowledge that a retry may create a duplicate provider charge.");
  });

  it("allows a pre-dispatch provider retry without duplicate-charge acknowledgement", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Pre-dispatch Retry");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({
        status: "failed",
        stage: "error",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage: "OpenRouter is not configured.",
        providerStartedAt: null,
        budgetChargeUsdMicros: 0,
        finishedAt: Date.now(),
      })
      .where(eq(runs.id, runId))
      .run();

    const retry = await enqueueRetry({
      handle: testEnv.handle,
      env: testEnv.env,
      runId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: false,
      idempotencyKey: randomUUID(),
    });
    const retryRunId = (retry.body as { runId: string }).runId;
    expect(retryRunId).not.toBe(runId);
    expect(testEnv.handle.db.select().from(runs).where(eq(runs.id, retryRunId)).get()?.status).toBe(
      "queued",
    );
  });

  it("rechecks the budget inside dispatch and stops queued live work", async () => {
    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: "test-key" };
    const project = createProject(testEnv.handle.db, testEnv.env, "Dispatch Budget");
    const queued = await enqueue(
      project.id,
      { mode: "preset", presetId: "cozy-living-room" },
      { env: liveEnv, reservation: 250_000 },
    );
    const runId = (queued.body as { runId: string }).runId;
    testEnv.handle.db
      .update(projects)
      .set({ budgetLimitUsdMicros: 1000 })
      .where(eq(projects.id, project.id))
      .run();
    const sibling = insertRun(testEnv.handle.db, project.id, {
      kind: "edit",
      executionMode: "live",
      status: "queued",
      stage: "queued",
      reservedUsdMicros: 1_000_000,
      budgetChargeUsdMicros: 1_000_000,
      createdAt: Date.now() + 1000,
    });

    await runGeneration(
      () => ({
        generate: async (): Promise<ImageGenerationResult> => {
          throw new Error("provider must not be called after a dispatch budget failure");
        },
      }),
      liveEnv,
    );

    const current = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(current?.status).toBe("failed");
    expect(current?.errorCode).toBe("BUDGET_EXCEEDED");
    expect(current?.budgetChargeUsdMicros).toBe(0);
    expect(current?.providerStartedAt).toBeNull();
    const stoppedSibling = testEnv.handle.db
      .select()
      .from(runs)
      .where(eq(runs.id, sibling.id))
      .get();
    expect(stoppedSibling?.status).toBe("failed");
    expect(stoppedSibling?.errorCode).toBe("BUDGET_EXCEEDED");
    expect(stoppedSibling?.budgetChargeUsdMicros).toBe(0);
    expect(getUsageEventByRunId(testEnv.handle.db, runId)).toBeUndefined();
    expect(getProjectSnapshot(testEnv.handle.db, project.id).versions).toEqual([]);
  });

  it("settles a live observed provider cost and persists the receipt", async () => {
    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: "test-key" };
    const project = createProject(testEnv.handle.db, testEnv.env, "Live Cost");
    const queued = await enqueue(
      project.id,
      { mode: "preset", presetId: "cozy-living-room" },
      { env: liveEnv, reservation: 250_000 },
    );
    const runId = (queued.body as { runId: string }).runId;

    await runGeneration(() => ({ generate: async () => imageResult(40_000) }), liveEnv);

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.project.rootVersionId).not.toBeNull();
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.budgetChargeUsdMicros).toBe(40_000);
    expect(run?.rawAssetId).not.toBeNull();
    expect(run?.normalizedRawAssetId).not.toBeNull();
    expect(run?.providerReceiptJson).toMatchObject({
      kind: "image",
      complete: true,
      responseMetadata: { observedCostUsdMicros: 40_000 },
    });
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage?.outcome).toBe("completed");
    expect(usage?.amountUsdMicros).toBe(40_000);
    expect(usage?.costProvenance).toBe("provider");
    expect(usage?.providerRequestId).toBe("req_live");
    expect(usage?.elapsedMs).toBe(12);
    expect(snapshot.runs[0]?.providerLatencyMs).toBe(12);
  });

  it("uses the reservation estimate for a completed image without billing data", async () => {
    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: "test-key" };
    const project = createProject(testEnv.handle.db, testEnv.env, "Estimated Cost");
    const queued = await enqueue(
      project.id,
      { mode: "preset", presetId: "cozy-living-room" },
      { env: liveEnv, reservation: 250_000 },
    );
    const runId = (queued.body as { runId: string }).runId;

    await runGeneration(() => ({ generate: async () => imageResult(null) }), liveEnv);

    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.budgetChargeUsdMicros).toBe(250_000);
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage?.amountUsdMicros).toBe(250_000);
    expect(usage?.costProvenance).toBe("estimated");
  });

  it("retains an unknown live hold for an ambiguous outcome", async () => {
    const liveEnv = { ...testEnv.env, aiMode: "live" as const, openRouterApiKey: "test-key" };
    const project = createProject(testEnv.handle.db, testEnv.env, "Live Ambiguous");
    const queued = await enqueue(
      project.id,
      { mode: "preset", presetId: "cozy-living-room" },
      { env: liveEnv, reservation: 250_000 },
    );
    const runId = (queued.body as { runId: string }).runId;

    await runGeneration(
      () => ({
        generate: async (): Promise<ImageGenerationResult> => ({
          kind: "ambiguous",
          message: "Timeout.",
          providerRequestId: null,
          usage: null,
          observedCostUsdMicros: null,
          latencyMs: 300_000,
        }),
      }),
      liveEnv,
    );

    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("needs_review");
    expect(run?.budgetChargeUsdMicros).toBe(250_000);
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage?.outcome).toBe("unknown");
    expect(usage?.amountUsdMicros).toBeNull();
    expect(usage?.costProvenance).toBe("unavailable");
    expect(getProjectSnapshot(testEnv.handle.db, project.id).versions).toEqual([]);
  });

  it("requeues a generation that crashed before provider dispatch", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery Pre-dispatch");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({ status: "running", stage: "preparing", startedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("queued");
    expect(run?.stage).toBe("queued");
    expect(run?.startedAt).toBeNull();
  });

  it("marks a settled completion without a receipt as local processing failure", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery Lost Output");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({
        status: "running",
        stage: "calling_provider",
        startedAt: Date.now(),
        providerStartedAt: Date.now(),
        budgetChargeUsdMicros: 250_000,
      })
      .where(eq(runs.id, runId))
      .run();
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId,
      operation: "generate",
      provider: "openrouter",
      model: "openai/gpt-image-2.5-flare",
      executionMode: "live",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId,
      outcome: "completed",
      amountUsdMicros: 250_000,
      costProvenance: "estimated",
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("LOCAL_PROCESSING_FAILED");
    expect(run?.budgetChargeUsdMicros).toBe(250_000);
    expect(getProjectSnapshot(testEnv.handle.db, project.id).versions).toEqual([]);
  });

  it("marks a dispatched generation without receipt or settled outcome for review", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery Ambiguous");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    testEnv.handle.db
      .update(runs)
      .set({
        status: "running",
        stage: "calling_provider",
        startedAt: Date.now(),
        providerStartedAt: Date.now(),
        budgetChargeUsdMicros: 250_000,
      })
      .where(eq(runs.id, runId))
      .run();
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId,
      operation: "generate",
      provider: "openrouter",
      model: "openai/gpt-image-2.5-flare",
      executionMode: "live",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("needs_review");
    expect(run?.errorCode).toBe("INTERRUPTED");
    expect(run?.budgetChargeUsdMicros).toBe(250_000);
    const usage = getUsageEventByRunId(testEnv.handle.db, runId);
    expect(usage?.outcome).toBe("unknown");
    expect(usage?.amountUsdMicros).toBeNull();
  });

  it("resumes local processing from a durable receipt without calling the provider", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery Receipt");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    const bytes = await readFile(
      join(process.cwd(), "src/test/fixtures/synthetic/living-room-v1.png"),
    );
    const rawAssetId = randomUUID();
    const written = await writeAssetBytes({
      assetDir: testEnv.env.assetDir,
      projectId: project.id,
      assetId: rawAssetId,
      mimeType: "image/png",
      bytes,
    });
    testEnv.handle.db
      .insert(assets)
      .values({
        id: rawAssetId,
        projectId: project.id,
        kind: "raw",
        relativePath: written.relativePath,
        sha256: written.sha256,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        bytes: bytes.length,
        createdAt: Date.now(),
      })
      .run();
    testEnv.handle.db
      .update(runs)
      .set({
        status: "running",
        stage: "calling_provider",
        startedAt: Date.now(),
        providerStartedAt: Date.now(),
        providerReceiptJson: {
          kind: "image",
          complete: true,
          rawAssetId,
          responseMetadata: {},
        },
        budgetChargeUsdMicros: 0,
      })
      .where(eq(runs.id, runId))
      .run();
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId,
      operation: "generate",
      provider: "mock",
      model: "openai/gpt-image-2.5-flare",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId,
      outcome: "completed",
      amountUsdMicros: 0,
      costProvenance: "calculated",
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const queuedRun = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(queuedRun?.status).toBe("queued");
    expect(queuedRun?.stage).toBe("processing");

    const result = await runGeneration(() => ({
      generate: async (): Promise<ImageGenerationResult> => {
        throw new Error("provider must not be called while resuming from a receipt");
      },
    }));
    expect(result.status).toBe("handled");
    expect(getProjectSnapshot(testEnv.handle.db, project.id).project.rootVersionId).not.toBeNull();
    expect(
      testEnv.handle.db.select().from(usageEvents).where(eq(usageEvents.runId, runId)).all(),
    ).toHaveLength(1);
  });

  it("local retry reuses a complete receipt without a provider call or new usage event", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Local Retry");
    const bytes = await readFile(
      join(process.cwd(), "src/test/fixtures/synthetic/living-room-v1.png"),
    );
    const rawAssetId = randomUUID();
    const written = await writeAssetBytes({
      assetDir: testEnv.env.assetDir,
      projectId: project.id,
      assetId: rawAssetId,
      mimeType: "image/png",
      bytes,
    });
    testEnv.handle.db
      .insert(assets)
      .values({
        id: rawAssetId,
        projectId: project.id,
        kind: "raw",
        relativePath: written.relativePath,
        sha256: written.sha256,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        bytes: bytes.length,
        createdAt: Date.now(),
      })
      .run();

    const snapshot = buildGenerationSnapshot({
      env: testEnv.env,
      resolved: resolveGenerationPrompt({ mode: "preset", presetId: "cozy-living-room" }),
      reservationUsdMicros: 0,
    });
    const runId = randomUUID();
    testEnv.handle.db
      .insert(runs)
      .values({
        id: runId,
        projectId: project.id,
        kind: "generate",
        executionMode: "mock",
        model: snapshot.model,
        inputSnapshotJson: snapshot,
        commonInputHash: snapshot.promptSha256,
        status: "failed",
        stage: "error",
        reservedUsdMicros: 0,
        budgetChargeUsdMicros: 0,
        providerStartedAt: Date.now(),
        providerReceiptJson: {
          kind: "image",
          complete: true,
          rawAssetId,
          responseMetadata: {},
        },
        errorCode: "LOCAL_PROCESSING_FAILED",
        errorMessage: "Local failure.",
        createdAt: Date.now(),
        finishedAt: Date.now(),
      })
      .run();
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId,
      operation: "generate",
      provider: "mock",
      model: snapshot.model,
      executionMode: "mock",
      pricingVersion: snapshot.pricingVersion,
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId,
      outcome: "completed",
      amountUsdMicros: 0,
      costProvenance: "calculated",
    });

    const retryKey = randomUUID();
    const retryInput = {
      handle: testEnv.handle,
      env: testEnv.env,
      runId,
      costConsent: consent(0),
      acknowledgePossibleDuplicateCharge: false,
      idempotencyKey: retryKey,
    };
    const retry = await enqueueRetry(retryInput);
    expect((retry.body as { runId: string }).runId).toBe(runId);

    const replay = await enqueueRetry(retryInput);
    expect(replay).toEqual(retry);
    expect(
      testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get()?.status,
    ).toBe("queued");

    const result = await runGeneration(() => ({
      generate: async () => {
        throw new Error("provider must not be called for a receipt-only local retry");
      },
    }));
    expect(result.status).toBe("handled");
    expect(getProjectSnapshot(testEnv.handle.db, project.id).project.rootVersionId).not.toBeNull();
    expect(
      testEnv.handle.db.select().from(usageEvents).where(eq(usageEvents.runId, runId)).all(),
    ).toHaveLength(1);
    expect(testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe(
      "succeeded",
    );
  });

  it("keeps the existing root when a generation completes too late", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Late");
    const queued = await enqueue(project.id, { mode: "preset", presetId: "cozy-living-room" });
    const runId = (queued.body as { runId: string }).runId;
    const manualRootId = installManualRoot(project.id);

    await runGeneration();

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.project.rootVersionId).toBe(manualRootId);
    expect(snapshot.versions).toHaveLength(1);
    const run = testEnv.handle.db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("ROOT_ALREADY_EXISTS");
    expect(run?.outputVersionId).toBeNull();
    expect(run?.rawAssetId).not.toBeNull();
    expect(run?.providerReceiptJson).not.toBeNull();
    expect(run?.budgetChargeUsdMicros).toBe(0);
    expect(run?.retryOfRunId).toBeNull();
    expect(
      testEnv.handle.db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.runId, runId))
        .get()?.outcome,
    ).toBe("completed");
  });
});

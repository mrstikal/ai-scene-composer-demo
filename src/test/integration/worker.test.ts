import { eq } from "drizzle-orm";
import * as lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runs } from "@/lib/db/schema";
import { claimNextRun, markRunFailed, recoverRunningRuns } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";
import {
  createPendingUsageEvent,
  getUsageEventByRunId,
  markUsageUnknown,
  settleUsageEvent,
} from "@/lib/usage/service";
import { createProject } from "@/lib/projects/service";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";
import { insertAssetRow, insertRun } from "@/test/helpers/domain";

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
});

afterEach(async () => {
  await testEnv.cleanup();
});

describe("worker claim and run-once", () => {
  it("claims the oldest queued run and never claims it twice", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Claims");
    const older = insertRun(testEnv.handle.db, project.id, { createdAt: 1000 });
    const newer = insertRun(testEnv.handle.db, project.id, { kind: "edit", createdAt: 2000 });

    const first = claimNextRun(testEnv.handle.db);
    expect(first?.id).toBe(older.id);
    expect(first?.status).toBe("running");
    expect(first?.startedAt).not.toBeNull();

    const second = claimNextRun(testEnv.handle.db);
    expect(second?.id).toBe(newer.id);

    expect(claimNextRun(testEnv.handle.db)).toBeNull();
  });

  it("fails safely when no domain handler is installed", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "No Handler");
    const run = insertRun(testEnv.handle.db, project.id, {
      reservedUsdMicros: 250_000,
      budgetChargeUsdMicros: 250_000,
    });

    const result = await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: {},
    });
    expect(result).toEqual({ status: "failed", runId: run.id, errorCode: "HANDLER_UNAVAILABLE" });

    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("failed");
    expect(stored?.errorCode).toBe("HANDLER_UNAVAILABLE");
    expect(stored?.budgetChargeUsdMicros).toBe(0);
  });

  it("runs an injected test handler and leaves success to the handler", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Handled");
    const run = insertRun(testEnv.handle.db, project.id);

    const result = await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: {
        generate: (claimed, context) => {
          context.db
            .update(runs)
            .set({ status: "succeeded", stage: "done", finishedAt: Date.now() })
            .where(eq(runs.id, claimed.id))
            .run();
        },
      },
    });
    expect(result).toEqual({ status: "handled", runId: run.id });
    expect(testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get()?.status).toBe(
      "succeeded",
    );
  });
});

describe("failure settlement", () => {
  it("does not overwrite a charge settled after the claim row was read", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Stale Charge");
    const claimed = insertRun(testEnv.handle.db, project.id, {
      reservedUsdMicros: 250_000,
      budgetChargeUsdMicros: 0,
    });
    testEnv.handle.db
      .update(runs)
      .set({ providerStartedAt: Date.now(), budgetChargeUsdMicros: 180_000 })
      .where(eq(runs.id, claimed.id))
      .run();

    markRunFailed(testEnv.handle.db, claimed, {
      code: "PROVIDER_ERROR",
      message: "failed after dispatch",
      preProvider: true,
    });

    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, claimed.id)).get();
    expect(stored?.budgetChargeUsdMicros).toBe(180_000);
  });
});

describe("startup recovery", () => {
  it("returns a run without provider invocation to the queue", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery 1");
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "preparing",
      startedAt: Date.now(),
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("queued");
    expect(stored?.stage).toBe("queued");
    expect(stored?.startedAt).toBeNull();
  });

  it("resumes local processing when a complete receipt and asset exist", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery 2");
    const asset = insertAssetRow(testEnv.handle.db, project.id);
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "calling_provider",
      startedAt: Date.now(),
      providerStartedAt: Date.now(),
      providerReceiptJson: {
        kind: "image",
        complete: true,
        rawAssetId: asset.id,
        responseMetadata: {},
      },
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("queued");
    expect(stored?.stage).toBe("processing");
  });

  it("does not treat a missing receipt artifact file as complete", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery Missing File");
    const asset = insertAssetRow(testEnv.handle.db, project.id);
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "calling_provider",
      startedAt: Date.now(),
      providerStartedAt: Date.now(),
      providerReceiptJson: {
        kind: "image",
        complete: true,
        rawAssetId: asset.id,
        responseMetadata: {},
      },
    });
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId: run.id,
      operation: "generate",
      provider: "openrouter",
      model: "mock",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId: run.id,
      outcome: "completed",
      amountUsdMicros: 0,
      costProvenance: "calculated",
    });

    expect(recoverRunningRuns(testEnv.handle.db, testEnv.env.assetDir)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("failed");
    expect(stored?.errorCode).toBe("LOCAL_PROCESSING_FAILED");
    expect(stored?.stage).toBe("error");
  });

  it("marks a settled completion without a receipt as local processing failure", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery 3");
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "calling_provider",
      startedAt: Date.now(),
      providerStartedAt: Date.now(),
      budgetChargeUsdMicros: 250_000,
    });
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId: run.id,
      operation: "generate",
      provider: "openrouter",
      model: "mock",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId: run.id,
      outcome: "completed",
      amountUsdMicros: 250_000,
      costProvenance: "estimated",
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("failed");
    expect(stored?.errorCode).toBe("LOCAL_PROCESSING_FAILED");
    expect(stored?.budgetChargeUsdMicros).toBe(250_000);
  });

  it("marks a settled rejection without a receipt as provider rejection", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery 4");
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "calling_provider",
      startedAt: Date.now(),
      providerStartedAt: Date.now(),
    });
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId: run.id,
      operation: "generate",
      provider: "openrouter",
      model: "mock",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId: run.id,
      outcome: "rejected",
      amountUsdMicros: 0,
      costProvenance: "calculated",
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("failed");
    expect(stored?.errorCode).toBe("PROVIDER_REJECTED");
  });

  it("marks an ambiguous dispatched run for review and keeps an unknown hold", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Recovery 5");
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "running",
      stage: "calling_provider",
      startedAt: Date.now(),
      providerStartedAt: Date.now(),
      reservedUsdMicros: 250_000,
      budgetChargeUsdMicros: 250_000,
    });
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId: run.id,
      operation: "generate",
      provider: "openrouter",
      model: "mock",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });

    expect(recoverRunningRuns(testEnv.handle.db)).toBe(1);
    const stored = testEnv.handle.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.status).toBe("needs_review");
    expect(stored?.errorCode).toBe("INTERRUPTED");
    expect(stored?.budgetChargeUsdMicros).toBe(250_000);

    const usage = getUsageEventByRunId(testEnv.handle.db, run.id);
    expect(usage?.outcome).toBe("unknown");
    expect(usage?.amountUsdMicros).toBeNull();
    expect(usage?.costProvenance).toBe("unavailable");
  });
});

describe("usage settlement safety", () => {
  it("does not overwrite an already settled event with unknown", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Usage");
    const run = insertRun(testEnv.handle.db, project.id);
    createPendingUsageEvent(testEnv.handle.db, {
      projectId: project.id,
      runId: run.id,
      operation: "generate",
      provider: "openrouter",
      model: "mock",
      executionMode: "mock",
      pricingVersion: "2026-10-21-v1",
      pricingSourceSnapshot: {},
    });
    settleUsageEvent(testEnv.handle.db, {
      runId: run.id,
      outcome: "completed",
      amountUsdMicros: 12_345,
      costProvenance: "provider",
    });

    markUsageUnknown(testEnv.handle.db, run.id);
    const usage = getUsageEventByRunId(testEnv.handle.db, run.id);
    expect(usage?.outcome).toBe("completed");
    expect(usage?.amountUsdMicros).toBe(12_345);
    expect(usage?.costProvenance).toBe("provider");
  });
});

describe("single-worker lock", () => {
  it("rejects a second worker lock", async () => {
    const release = await lockfile.lock(testEnv.env.databasePath, {
      retries: 0,
      update: 5000,
      stale: 120000,
      realpath: false,
    });

    await expect(
      lockfile.lock(testEnv.env.databasePath, {
        retries: 0,
        update: 5000,
        stale: 120000,
        realpath: false,
      }),
    ).rejects.toThrow();

    await release();
  });
});

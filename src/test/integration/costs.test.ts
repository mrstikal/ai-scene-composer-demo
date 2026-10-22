import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "@/lib/config/env";
import { getPricingConfig } from "@/lib/config/pricing";
import type { CostConsent } from "@/lib/contracts/api";
import { getProjectCosts } from "@/lib/costs/service";
import { selections } from "@/lib/db/schema";
import { editReservationUsdMicros, enqueueEdit } from "@/lib/edits/service";
import { createEditHandler, type EditHandlerOptions } from "@/lib/jobs/handlers/edit";
import { createSegmentHandler } from "@/lib/jobs/handlers/segment";
import { runOnce } from "@/lib/jobs/worker";
import {
  createProject,
  importSample,
} from "@/lib/projects/service";
import { enqueueSegmentation } from "@/lib/segmentations/service";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";

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

async function sampleWithSelection(): Promise<{
  projectId: string;
  rootVersionId: string;
  selectionId: string;
}> {
  const project = createProject(testEnv.handle.db, testEnv.env, "Costs");
  const imported = await importSample({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId: project.id,
    sampleId: "living-room-v1",
    idempotencyKey: randomUUID(),
  });
  const rootVersionId = (imported.body as { rootVersionId: string }).rootVersionId;
  await enqueueSegmentation({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId: project.id,
    sourceVersionId: rootVersionId,
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
  const selection = testEnv.handle.db.select().from(selections).get();
  if (selection === undefined) throw new Error("Selection is missing.");
  return { projectId: project.id, rootVersionId, selectionId: selection.id };
}

async function enqueueLiveEdit(input: {
  projectId: string;
  rootVersionId: string;
  selectionId: string;
}): Promise<string> {
  const env = liveEnv();
  const stored = await enqueueEdit({
    handle: testEnv.handle,
    env,
    projectId: input.projectId,
    parentVersionId: input.rootVersionId,
    selectionId: input.selectionId,
    paddingPx: 16,
    targetLabel: "sofa",
    instruction: "Make the sofa green.",
    referenceAssetIds: [],
    model: "openai/gpt-image-2.5-flare",
    costConsent: consent(editReservationUsdMicros(env)),
    idempotencyKey: randomUUID(),
  });
  return (stored.body as { runId: string }).runId;
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

describe("project cost partition", () => {
  it("keeps an active reservation while a live edit is queued", async () => {
    const { projectId, rootVersionId, selectionId } = await sampleWithSelection();
    await enqueueLiveEdit({ projectId, rootVersionId, selectionId });

    const costs = getProjectCosts(testEnv.handle.db, projectId);
    expect(costs.totals.activeReservationUsdMicros).toBe(250_000);
    expect(costs.totals.unknownHoldUsdMicros).toBe(0);
    expect(costs.totals.estimatedUsdMicros).toBe(0);
    expect(costs.totals.commitmentUsdMicros).toBe(250_000);
    expect(costs.totals.remainingUsdMicros).toBe(4_750_000);
    expect(costs.totals.overrunUsdMicros).toBe(0);
  });

  it("retains an unknown-charge hold when the provider outcome is ambiguous", async () => {
    const { projectId, rootVersionId, selectionId } = await sampleWithSelection();
    const env = liveEnv();
    await enqueueLiveEdit({ projectId, rootVersionId, selectionId });
    await runEdit(
      () => ({
        edit: async () => ({
          kind: "ambiguous",
          message: "Provider outcome is unknown.",
          providerRequestId: null,
          usage: null,
          observedCostUsdMicros: null,
          latencyMs: null,
        }),
      }),
      env,
    );

    const costs = getProjectCosts(testEnv.handle.db, projectId);
    expect(costs.totals.activeReservationUsdMicros).toBe(0);
    expect(costs.totals.unknownHoldUsdMicros).toBe(250_000);
    expect(costs.totals.estimatedUsdMicros).toBe(0);
    expect(costs.totals.commitmentUsdMicros).toBe(250_000);
    expect(costs.events.at(-1)).toMatchObject({
      outcome: "unknown",
      amountUsdMicros: null,
      costProvenance: "unavailable",
    });
  });
});

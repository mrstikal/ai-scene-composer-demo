import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as comparisonRoute } from "@/app/api/comparisons/route";
import { GET as comparisonDetailRoute } from "@/app/api/comparisons/[id]/route";
import { GET as costsRoute } from "@/app/api/projects/[id]/costs/route";
import { PATCH as evaluationRoute } from "@/app/api/runs/[id]/evaluation/route";
import { POST as createProjectRoute } from "@/app/api/projects/route";
import { POST as sampleRoute } from "@/app/api/projects/[id]/sample/route";
import type {
  ComparisonDetailDto,
  ComparisonResponse,
  EvaluationResponse,
  ProjectCostsDto,
} from "@/lib/contracts/api";
import { getPricingConfig } from "@/lib/config/pricing";
import { resetDatabaseForTests } from "@/lib/db/client";
import { createEditHandler } from "@/lib/jobs/handlers/edit";
import { createSegmentHandler } from "@/lib/jobs/handlers/segment";
import { runOnce } from "@/lib/jobs/worker";
import { getProjectSnapshot } from "@/lib/projects/service";
import { enqueueSegmentation } from "@/lib/segmentations/service";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";

const ENV_KEYS = [
  "AI_MODE",
  "SAM_MODE",
  "RUN_LIVE_AI_TESTS",
  "DATABASE_PATH",
  "ASSET_DIR",
  "PROJECT_BUDGET_USD",
  "IMAGE_RESERVATION_USD",
  "OPENROUTER_API_KEY",
  "META_MODEL_API_KEY",
] as const;

let testEnv: TestEnvironment;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AI_MODE = "mock";
  process.env.SAM_MODE = "fixture";
  process.env.RUN_LIVE_AI_TESTS = "0";
  process.env.DATABASE_PATH = testEnv.env.databasePath;
  process.env.ASSET_DIR = testEnv.env.assetDir;
  process.env.PROJECT_BUDGET_USD = "5";
  process.env.IMAGE_RESERVATION_USD = "0.25";
  process.env.OPENROUTER_API_KEY = "";
  process.env.META_MODEL_API_KEY = "";
  resetDatabaseForTests();
});

afterEach(async () => {
  resetDatabaseForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await testEnv.cleanup();
});

async function projectWithSelection(): Promise<{
  projectId: string;
  rootVersionId: string;
  selectionId: string;
}> {
  const createResponse = await createProjectRoute(
    new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Phase 5 Routes" }),
    }),
  );
  const { projectId } = (await createResponse.json()) as { projectId: string };

  const sampleResponse = await sampleRoute(
    new Request(`http://localhost/api/projects/${projectId}/sample`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ sampleId: "living-room-v1" }),
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
  const { rootVersionId } = (await sampleResponse.json()) as { rootVersionId: string };

  const stored = await enqueueSegmentation({
    handle: testEnv.handle,
    env: testEnv.env,
    projectId,
    sourceVersionId: rootVersionId,
    positivePoints: [{ x: 420, y: 610 }],
    negativePoints: [],
    costConsent: {
      pricingVersion: getPricingConfig().version,
      reservationUsdMicros: 0,
      acknowledged: true,
    },
    idempotencyKey: randomUUID(),
  });
  await runOnce({
    db: testEnv.handle.db,
    sqlite: testEnv.handle.sqlite,
    env: testEnv.env,
    handlers: { segment: createSegmentHandler() },
  });
  const runId = (stored.body as { runId: string }).runId;
  const snapshot = getProjectSnapshot(testEnv.handle.db, projectId, testEnv.env);
  const selection = snapshot.runs.find((run) => run.id === runId)?.outputSelectionId;
  if (selection === null || selection === undefined) {
    throw new Error("Selection is missing.");
  }
  return { projectId, rootVersionId, selectionId: selection };
}

function comparisonBody(input: {
  projectId: string;
  rootVersionId: string;
  selectionId: string;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    parentVersionId: input.rootVersionId,
    selectionId: input.selectionId,
    paddingPx: 16,
    targetLabel: "sofa",
    instruction: "Make the sofa green.",
    referenceAssetIds: [],
    costConsent: {
      pricingVersion: getPricingConfig().version,
      reservationUsdMicros: 0,
      acknowledged: true,
    },
  };
}

describe("Phase 5 HTTP routes", () => {
  it("enqueues, reads, evaluates and meters a comparison through route handlers", async () => {
    const input = await projectWithSelection();

    const missingKey = await comparisonRoute(
      new Request("http://localhost/api/comparisons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(comparisonBody(input)),
      }),
    );
    expect(missingKey.status).toBe(400);

    const unknownField = await comparisonRoute(
      new Request("http://localhost/api/comparisons", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ ...comparisonBody(input), model: "openai/gpt-image-2.5-flare" }),
      }),
    );
    expect(unknownField.status).toBe(400);

    const response = await comparisonRoute(
      new Request("http://localhost/api/comparisons", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify(comparisonBody(input)),
      }),
    );
    expect(response.status).toBe(202);
    const created = (await response.json()) as ComparisonResponse;
    expect(created.runIds).toHaveLength(2);

    await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: { edit: createEditHandler() },
    });
    await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: { edit: createEditHandler() },
    });

    const detailResponse = await comparisonDetailRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: created.comparisonGroupId }),
    });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as ComparisonDetailDto;
    expect(detail.runs).toHaveLength(2);
    expect(detail.candidateCost.byModel).toHaveLength(2);

    const flare = detail.runs.find((run) => run.model.includes("flare"));
    if (flare === undefined) throw new Error("Flare run is missing.");

    const invalidEvaluation = await evaluationRoute(
      new Request(`http://localhost/api/runs/${flare.id}/evaluation`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boundaryArtifacts: 6,
          promptAdherence: 4,
          referenceFidelity: null,
          plausibility: 3,
          notes: "",
        }),
      }),
      { params: Promise.resolve({ id: flare.id }) },
    );
    expect(invalidEvaluation.status).toBe(400);

    const evaluationResponse = await evaluationRoute(
      new Request(`http://localhost/api/runs/${flare.id}/evaluation`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boundaryArtifacts: 4,
          promptAdherence: 5,
          referenceFidelity: null,
          plausibility: 3,
          notes: "Route evaluation.",
        }),
      }),
      { params: Promise.resolve({ id: flare.id }) },
    );
    expect(evaluationResponse.status).toBe(200);
    expect((await evaluationResponse.json()) as EvaluationResponse).toMatchObject({
      evaluation: { boundaryArtifacts: 4, notes: "Route evaluation." },
    });

    const costsResponse = await costsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: input.projectId }),
    });
    expect(costsResponse.status).toBe(200);
    const costs = (await costsResponse.json()) as ProjectCostsDto;
    expect(costs.totals.commitmentUsdMicros).toBe(0);
    expect(costs.events).toHaveLength(3);

    const missingComparison = await comparisonDetailRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(missingComparison.status).toBe(404);

    const missingProjectCosts = await costsRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(missingProjectCosts.status).toBe(404);
  });
});

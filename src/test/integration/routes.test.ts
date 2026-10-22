import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getAssetRoute } from "@/app/api/assets/[id]/route";
import { POST as uploadAssetRoute } from "@/app/api/assets/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { GET as getProjectRoute } from "@/app/api/projects/[id]/route";
import { POST as sampleRoute } from "@/app/api/projects/[id]/sample/route";
import { GET as listProjectsRoute, POST as createProjectRoute } from "@/app/api/projects/route";
import { POST as editRoute } from "@/app/api/edits/route";
import { POST as segmentationRoute } from "@/app/api/segmentations/route";
import { resetDatabaseForTests } from "@/lib/db/client";
import type { HealthResponse, ProjectSnapshotDto } from "@/lib/contracts/api";
import { createEditHandler } from "@/lib/jobs/handlers/edit";
import { createSegmentHandler } from "@/lib/jobs/handlers/segment";
import { runOnce } from "@/lib/jobs/worker";
import { createTestEnvironment, createTestImage, type TestEnvironment } from "@/test/helpers/environment";

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

describe("HTTP route contracts", () => {
  it("creates and reads a project through the route handlers", async () => {
    const createResponse = await createProjectRoute(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Route Project" }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { projectId: string };
    expect(created.projectId).toMatch(/^[0-9a-f-]{36}$/);

    const listResponse = await listProjectsRoute();
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as { projects: Array<{ id: string; title: string }> };
    expect(list.projects).toEqual([
      expect.objectContaining({ id: created.projectId, title: "Route Project" }),
    ]);

    const readResponse = await getProjectRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: created.projectId }),
    });
    expect(readResponse.status).toBe(200);
    const snapshot = (await readResponse.json()) as ProjectSnapshotDto;
    expect(snapshot.project.title).toBe("Route Project");
    expect(snapshot.versions).toEqual([]);
  });

  it("imports a sample through the route and serves the canonical asset", async () => {
    const createResponse = await createProjectRoute(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Sample Route" }),
      }),
    );
    const { projectId } = (await createResponse.json()) as { projectId: string };

    const sampleResponse = await sampleRoute(
      new Request(`http://localhost/api/projects/${projectId}/sample`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ sampleId: "living-room-v1" }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(sampleResponse.status).toBe(201);
    const sample = (await sampleResponse.json()) as { rootVersionId: string; assetId: string };

    const assetResponse = await getAssetRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: sample.assetId }),
    });
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toBe("image/png");
    expect(assetResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await assetResponse.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const readResponse = await getProjectRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: projectId }),
    });
    const snapshot = (await readResponse.json()) as ProjectSnapshotDto;
    expect(snapshot.project.rootVersionId).toBe(sample.rootVersionId);
  });

  it("uploads a base image through multipart and reports ready health", async () => {
    const createResponse = await createProjectRoute(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Upload Route" }),
      }),
    );
    const { projectId } = (await createResponse.json()) as { projectId: string };

    const form = new FormData();
    form.set("projectId", projectId);
    form.set("role", "base");
    const imageBytes = await createTestImage({ width: 200, height: 100 });
    const arrayBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    form.set("file", new File([arrayBuffer], "base.png", { type: "image/png" }));

    const uploadResponse = await uploadAssetRoute(
      new Request("http://localhost/api/assets", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: form,
      }),
    );
    expect(uploadResponse.status).toBe(201);
    const uploaded = (await uploadResponse.json()) as { rootVersionId: string; width: number };
    expect(uploaded.rootVersionId).not.toBeNull();
    expect(uploaded.width).toBe(1024);

    const healthResponse = await healthRoute();
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as HealthResponse;
    expect(health.status).toBe("ready");
    expect(health.modes).toEqual({ ai: "mock", sam: "fixture" });
    expect(health.fixtures.sampleProvenance).toBe("synthetic");
    expect(health.worker.status).toBe("missing");
  });

  it("enqueues a SAM selection through the route and reads it back after the worker", async () => {
    const createResponse = await createProjectRoute(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Selection Route" }),
      }),
    );
    const { projectId } = (await createResponse.json()) as { projectId: string };

    const sampleResponse = await sampleRoute(
      new Request(`http://localhost/api/projects/${projectId}/sample`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ sampleId: "living-room-v1" }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    const sample = (await sampleResponse.json()) as { rootVersionId: string };

    const selectionResponse = await segmentationRoute(
      new Request("http://localhost/api/segmentations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          projectId,
          sourceVersionId: sample.rootVersionId,
          positivePoints: [{ x: 420, y: 610 }],
          negativePoints: [],
          costConsent: {
            pricingVersion: "2026-10-21-v1",
            reservationUsdMicros: 0,
            acknowledged: true,
          },
        }),
      }),
    );
    expect(selectionResponse.status).toBe(202);
    const { runId } = (await selectionResponse.json()) as { runId: string };

    const queuedResponse = await getProjectRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: projectId }),
    });
    const queued = (await queuedResponse.json()) as ProjectSnapshotDto;
    expect(queued.runs.find((run) => run.id === runId)).toMatchObject({
      kind: "segment",
      status: "queued",
      parentVersionId: sample.rootVersionId,
    });

    const worker = await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: { segment: createSegmentHandler() },
    });
    expect(worker).toEqual({ status: "handled", runId });

    const completedResponse = await getProjectRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: projectId }),
    });
    const completed = (await completedResponse.json()) as ProjectSnapshotDto;
    expect(completed.selections).toHaveLength(1);
    expect(completed.runs.find((run) => run.id === runId)).toMatchObject({
      status: "succeeded",
      outputSelectionId: completed.selections[0]?.id,
      cost: { budgetChargeUsdMicros: 0 },
    });

    const selection = completed.selections[0];
    if (selection === undefined) throw new Error("Selection is missing.");
    const editResponse = await editRoute(
      new Request("http://localhost/api/edits", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          projectId,
          parentVersionId: sample.rootVersionId,
          selectionId: selection.id,
          paddingPx: 16,
          targetLabel: "sofa",
          instruction: "Make the sofa green.",
          referenceAssetIds: [],
          model: "openai/gpt-image-2.5-flare",
          costConsent: {
            pricingVersion: "2026-10-21-v1",
            reservationUsdMicros: 0,
            acknowledged: true,
          },
        }),
      }),
    );
    expect(editResponse.status).toBe(202);
    const { runId: editRunId } = (await editResponse.json()) as { runId: string };

    const editWorker = await runOnce({
      db: testEnv.handle.db,
      sqlite: testEnv.handle.sqlite,
      env: testEnv.env,
      handlers: { edit: createEditHandler() },
    });
    expect(editWorker).toEqual({ status: "handled", runId: editRunId });

    const editedResponse = await getProjectRoute(new Request("http://localhost"), {
      params: Promise.resolve({ id: projectId }),
    });
    const edited = (await editedResponse.json()) as ProjectSnapshotDto;
    const editRun = edited.runs.find((run) => run.id === editRunId);
    expect(editRun).toMatchObject({
      status: "succeeded",
      parentVersionId: sample.rootVersionId,
    });
    expect(edited.project.activeVersionId).toBe(sample.rootVersionId);
    const child = edited.versions.find((version) => version.id === editRun?.outputVersionId);
    expect(child).toMatchObject({
      parentVersionId: sample.rootVersionId,
      origin: "edit",
    });
  });
});

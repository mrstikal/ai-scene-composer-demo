import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getAssetRoute } from "@/app/api/assets/[id]/route";
import { POST as uploadAssetRoute } from "@/app/api/assets/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { GET as getProjectRoute } from "@/app/api/projects/[id]/route";
import { POST as sampleRoute } from "@/app/api/projects/[id]/sample/route";
import { GET as listProjectsRoute, POST as createProjectRoute } from "@/app/api/projects/route";
import { resetDatabaseForTests } from "@/lib/db/client";
import type { HealthResponse, ProjectSnapshotDto } from "@/lib/contracts/api";
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
});

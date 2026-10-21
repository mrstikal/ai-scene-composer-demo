import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAssetBytes } from "@/lib/assets/store";
import { createDatabase } from "@/lib/db/client";
import { assets, versions } from "@/lib/db/schema";
import { inspectImage } from "@/lib/images/normalize";
import {
  createProject,
  getProjectSnapshot,
  importSample,
  importUploadedAsset,
  listProjects,
  setActiveVersion,
} from "@/lib/projects/service";
import { createTestEnvironment, createTestImage, type TestEnvironment } from "@/test/helpers/environment";
import { insertRun } from "@/test/helpers/domain";

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
});

afterEach(async () => {
  await testEnv.cleanup();
});

describe("projects and root initialization", () => {
  it("creates, lists and reads back an empty project", () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "  Living Room  ");
    expect(project.title).toBe("Living Room");
    expect(project.rootVersionId).toBeNull();
    expect(project.activeVersionId).toBeNull();
    expect(project.budgetLimitUsdMicros).toBe(5_000_000);

    const listed = listProjects(testEnv.handle.db);
    expect(listed.projects).toEqual([
      { id: project.id, title: "Living Room", createdAt: project.createdAt },
    ]);

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.project.id).toBe(project.id);
    expect(snapshot.versions).toEqual([]);
    expect(snapshot.selections).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.pricing.version).toBe("2026-10-21-v1");
  });

  it("rejects blank titles", () => {
    expect(() => createProject(testEnv.handle.db, testEnv.env, "   ")).toThrow(
      "Project title must contain 1-120 characters.",
    );
  });

  it("imports the bundled sample once and replays the same idempotency key", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Sample");
    const key = crypto.randomUUID();

    const first = await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const body = first.body as { rootVersionId: string; assetId: string };
    expect(body.rootVersionId).toMatch(/^[0-9a-f-]{36}$/);

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.versions).toHaveLength(1);
    expect(snapshot.versions[0]?.origin).toBe("sample");
    expect(snapshot.project.rootVersionId).toBe(body.rootVersionId);
    expect(snapshot.project.activeVersionId).toBe(body.rootVersionId);

    const assetRows = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.projectId, project.id))
      .all();
    expect(assetRows.map((asset) => asset.kind).sort()).toEqual(["canonical", "original"]);
    const canonical = assetRows.find((asset) => asset.id === body.assetId);
    expect(canonical).toBeDefined();
    if (canonical !== undefined) {
      const bytes = await readAssetBytes(testEnv.env.assetDir, canonical.relativePath);
      const inspected = await inspectImage(bytes);
      expect(inspected.width).toBe(1024);
      expect(inspected.height).toBe(1024);
    }

    const replay = await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: key,
    });
    expect(replay).toEqual(first);
    expect(
      testEnv.handle.db.select().from(versions).where(eq(versions.projectId, project.id)).all(),
    ).toHaveLength(1);

    await expect(
      importSample({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId: project.id,
        sampleId: "living-room-v1",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("This project already has a root scene.");
  });

  it("reads the sample root back after reopening the database", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Restart");
    await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: crypto.randomUUID(),
    });

    testEnv.handle.close();
    testEnv.handle = createDatabase(testEnv.env.databasePath);

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.versions).toHaveLength(1);
    expect(snapshot.project.activeVersionId).toBe(snapshot.project.rootVersionId);
  });

  it("uploads a base image, normalizes it and replays safely", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Upload");
    const bytes = await createTestImage({
      width: 200,
      height: 100,
      background: { r: 20, g: 30, b: 40 },
    });
    const key = crypto.randomUUID();

    const first = await importUploadedAsset({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      role: "base",
      bytes,
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const body = first.body as { assetId: string; rootVersionId: string; width: number; height: number };
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    expect(body.rootVersionId).not.toBeNull();

    const snapshot = getProjectSnapshot(testEnv.handle.db, project.id);
    expect(snapshot.versions[0]?.origin).toBe("upload");

    const original = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.kind, "original"))
      .get();
    expect(original?.width).toBe(200);
    expect(original?.height).toBe(100);

    const replay = await importUploadedAsset({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      role: "base",
      bytes,
      idempotencyKey: key,
    });
    expect(replay).toEqual(first);

    await expect(
      importUploadedAsset({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId: project.id,
        role: "base",
        bytes,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("This project already has a root scene.");
  });

  it("stores references without creating a version and allows them after a root", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "References");
    const referenceBytes = await createTestImage({ width: 2000, height: 1000 });

    const reference = await importUploadedAsset({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      role: "reference",
      bytes: referenceBytes,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reference.status).toBe(201);
    expect(reference.body).toMatchObject({
      rootVersionId: null,
      width: 1024,
      height: 512,
    });
    expect(getProjectSnapshot(testEnv.handle.db, project.id).versions).toEqual([]);

    await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: crypto.randomUUID(),
    });

    const afterRoot = await importUploadedAsset({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      role: "reference",
      bytes: referenceBytes,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(afterRoot.status).toBe(201);
    expect(afterRoot.body).toMatchObject({ rootVersionId: null });
  });

  it("rejects a reused key with a different payload", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Conflict");
    const key = crypto.randomUUID();
    const firstBytes = await createTestImage({ width: 200, height: 100 });
    const secondBytes = await createTestImage({ width: 300, height: 100 });

    await importUploadedAsset({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      role: "reference",
      bytes: firstBytes,
      idempotencyKey: key,
    });

    await expect(
      importUploadedAsset({
        handle: testEnv.handle,
        env: testEnv.env,
        projectId: project.id,
        role: "reference",
        bytes: secondBytes,
        idempotencyKey: key,
      }),
    ).rejects.toThrow("The Idempotency-Key was already used with a different request.");
  });

  it("does not expose storage paths, receipts, input snapshots or keys in read models", async () => {
    const project = createProject(testEnv.handle.db, testEnv.env, "Safe DTO");
    await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: crypto.randomUUID(),
    });
    const asset = testEnv.handle.db
      .select()
      .from(assets)
      .where(eq(assets.projectId, project.id))
      .get();
    if (asset === undefined) throw new Error("Expected an asset.");
    insertRun(testEnv.handle.db, project.id, {
      providerReceiptJson: {
        kind: "image",
        complete: true,
        rawAssetId: asset.id,
        responseMetadata: { private: "receipt-only" },
      },
      inputSnapshotJson: { private: "input-only" },
    });

    const serialized = JSON.stringify(getProjectSnapshot(testEnv.handle.db, project.id));
    expect(serialized).not.toContain(testEnv.env.assetDir);
    expect(serialized).not.toContain("relativePath");
    expect(serialized).not.toContain("providerReceipt");
    expect(serialized).not.toContain("inputSnapshot");
    expect(serialized).not.toContain("receipt-only");
    expect(serialized).not.toContain("input-only");
  });

  it("rejects selecting a version from another project", async () => {
    const firstProject = createProject(testEnv.handle.db, testEnv.env, "First");
    const secondProject = createProject(testEnv.handle.db, testEnv.env, "Second");
    const first = await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: firstProject.id,
      sampleId: "living-room-v1",
      idempotencyKey: crypto.randomUUID(),
    });
    await importSample({
      handle: testEnv.handle,
      env: testEnv.env,
      projectId: secondProject.id,
      sampleId: "living-room-v1",
      idempotencyKey: crypto.randomUUID(),
    });

    const firstVersionId = (first.body as { rootVersionId: string }).rootVersionId;
    expect(() =>
      setActiveVersion(testEnv.handle.db, secondProject.id, firstVersionId),
    ).toThrow("Version was not found in this project.");
    expect(setActiveVersion(testEnv.handle.db, firstProject.id, firstVersionId)).toBe(
      firstVersionId,
    );
  });
});

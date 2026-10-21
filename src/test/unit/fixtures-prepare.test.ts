import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareFixtures } from "@/lib/fixtures/prepare";
import { createTestImage } from "@/test/helpers/environment";

const roots: string[] = [];

async function tempFixtures(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scene-composer-fixtures-"));
  roots.push(root);
  return root;
}

async function writeLicense(root: string, fixtureId: string): Promise<void> {
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(
    join(root, "licenses", `${fixtureId}.md`),
    [
      `# ${fixtureId}`,
      "Creator: Test Owner",
      "Source: owner-provided permission record",
      "License: redistributable test use",
      "Acquired: 2026-10-21",
      "Attribution: none",
      "Modifications: resized and metadata stripped",
    ].join("\n"),
  );
}

async function writePhoto(root: string, fixtureId: string, extension: "png" | "jpg"): Promise<Buffer> {
  await mkdir(join(root, "photos"), { recursive: true });
  const bytes = await createTestImage({ width: 1200, height: 1200, format: extension === "jpg" ? "jpeg" : "png" });
  await writeFile(join(root, "photos", `${fixtureId}.${extension}`), bytes);
  return bytes;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("offline fixture preparation", () => {
  it("selects labeled synthetic fallbacks and is idempotent", async () => {
    const root = await tempFixtures();
    const first = await prepareFixtures(root);
    expect(first.licensedPhotosReady).toBe(false);
    expect(first.samFixtureReady).toBe(false);
    expect(first.fixtures.map((fixture) => fixture.provenance)).toEqual(["synthetic", "synthetic"]);
    expect(first.fixtures.every((fixture) => fixture.licenseRecord === null)).toBe(true);

    const roomBefore = await readFile(join(root, "synthetic/living-room-v1.png"));
    const sofaBefore = await readFile(join(root, "synthetic/reference-sofa-v1.png"));
    const manifestBefore = await readFile(join(root, "manifest.json"));

    const second = await prepareFixtures(root);
    expect(second).toEqual(first);
    expect(await readFile(join(root, "synthetic/living-room-v1.png"))).toEqual(roomBefore);
    expect(await readFile(join(root, "synthetic/reference-sofa-v1.png"))).toEqual(sofaBefore);
    expect(await readFile(join(root, "manifest.json"))).toEqual(manifestBefore);
  });

  it("rejects a supplied photograph without a permission record", async () => {
    const root = await tempFixtures();
    await prepareFixtures(root);
    await writePhoto(root, "living-room-v1", "png");
    await expect(prepareFixtures(root)).rejects.toThrow(
      "Photograph living-room-v1 exists without licenses/living-room-v1.md.",
    );
  });

  it("rejects ambiguous photo extensions", async () => {
    const root = await tempFixtures();
    await prepareFixtures(root);
    await writePhoto(root, "living-room-v1", "png");
    await writePhoto(root, "living-room-v1", "jpg");
    await writeLicense(root, "living-room-v1");
    await expect(prepareFixtures(root)).rejects.toThrow(
      "Both .jpg and .png exist for living-room-v1. Keep exactly one photograph.",
    );
  });

  it("enforces the supplied photo dimensions", async () => {
    const root = await tempFixtures();
    await prepareFixtures(root);
    await writeLicense(root, "living-room-v1");
    await writeLicense(root, "reference-sofa-v1");

    await mkdir(join(root, "photos"), { recursive: true });
    await writeFile(
      join(root, "photos/living-room-v1.png"),
      await createTestImage({ width: 1200, height: 800 }),
    );
    await expect(prepareFixtures(root)).rejects.toThrow(
      "living-room-v1 photograph must be square.",
    );

    await rm(join(root, "photos/living-room-v1.png"));
    await writeFile(
      join(root, "photos/living-room-v1.png"),
      await createTestImage({ width: 800, height: 800 }),
    );
    await expect(prepareFixtures(root)).rejects.toThrow(
      "living-room-v1 photograph must be at least 1024 x 1024 pixels.",
    );

    await rm(join(root, "photos/living-room-v1.png"));
    await writeFile(
      join(root, "photos/living-room-v1.png"),
      await createTestImage({ width: 1200, height: 1200 }),
    );
    await writeFile(
      join(root, "photos/reference-sofa-v1.png"),
      await createTestImage({ width: 800, height: 600 }),
    );
    await expect(prepareFixtures(root)).rejects.toThrow(
      "reference-sofa-v1 photograph must be at least 1024 pixels on its longest side.",
    );
  });

  it("prefers licensed photographs and preserves their bytes and records", async () => {
    const root = await tempFixtures();
    await prepareFixtures(root);
    const roomBytes = await writePhoto(root, "living-room-v1", "png");
    const sofaBytes = await writePhoto(root, "reference-sofa-v1", "jpg");
    await writeLicense(root, "living-room-v1");
    await writeLicense(root, "reference-sofa-v1");

    const manifest = await prepareFixtures(root);
    expect(manifest.licensedPhotosReady).toBe(true);
    expect(manifest.fixtures.map((fixture) => fixture.provenance)).toEqual([
      "licensed_photo",
      "licensed_photo",
    ]);
    expect(manifest.fixtures[0]?.selectedPath).toBe("photos/living-room-v1.png");
    expect(manifest.fixtures[1]?.selectedPath).toBe("photos/reference-sofa-v1.jpg");
    expect(manifest.fixtures[0]?.licenseRecord).toBe("licenses/living-room-v1.md");
    expect(await readFile(join(root, "photos/living-room-v1.png"))).toEqual(roomBytes);
    expect(await readFile(join(root, "photos/reference-sofa-v1.jpg"))).toEqual(sofaBytes);
  });
});

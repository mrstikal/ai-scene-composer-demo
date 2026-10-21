import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mimeTypeForFormat,
  readAssetBytes,
  resolveAssetPath,
  sha256Hex,
  writeAssetBytes,
} from "@/lib/assets/store";
import { createTestImage } from "@/test/helpers/environment";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scene-composer-assets-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private asset store", () => {
  it("writes, hashes and reads a new asset", async () => {
    const assetDir = await tempRoot();
    const projectId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = await createTestImage({ width: 20, height: 20 });

    const written = await writeAssetBytes({
      assetDir,
      projectId,
      assetId,
      mimeType: "image/png",
      bytes,
    });

    expect(written.relativePath).toBe(`${projectId}/${assetId}.png`);
    expect(written.sha256).toBe(sha256Hex(bytes));
    expect(await readAssetBytes(assetDir, written.relativePath)).toEqual(bytes);
  });

  it("never overwrites an existing asset path", async () => {
    const assetDir = await tempRoot();
    const projectId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const bytes = await createTestImage({ width: 20, height: 20 });

    await writeAssetBytes({ assetDir, projectId, assetId, mimeType: "image/png", bytes });
    await expect(
      writeAssetBytes({ assetDir, projectId, assetId, mimeType: "image/png", bytes }),
    ).rejects.toThrow();
  });

  it("rejects path traversal and absolute paths", async () => {
    const assetDir = await tempRoot();
    expect(() => resolveAssetPath(assetDir, "../secret.png")).toThrow(
      "Asset path escapes the asset directory.",
    );
    expect(() => resolveAssetPath(assetDir, "/tmp/secret.png")).toThrow(
      "Asset path must be relative.",
    );
    await expect(readAssetBytes(assetDir, "../secret.png")).rejects.toThrow(
      "Asset path escapes the asset directory.",
    );
  });

  it("maps validated formats to extensions and MIME types", () => {
    expect(mimeTypeForFormat("png")).toBe("image/png");
    expect(mimeTypeForFormat("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForFormat("webp")).toBe("image/webp");
    expect(mimeTypeForFormat("gif")).toBeNull();
  });
});

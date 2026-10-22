import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSafeTarget } from "../../../scripts/reset-local-data";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scene-reset-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local reset path validation", () => {
  it("accepts a normal repository-owned target", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "assets-local", "project"), { recursive: true });
    expect(() =>
      assertSafeTarget(root, join(root, "assets-local", "project"), "asset directory"),
    ).not.toThrow();
  });

  it("rejects a target reached through a symlinked ancestor", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, "assets-local"));
    mkdirSync(join(outside, "photos"));
    symlinkSync(outside, join(root, "assets-local", "link"));

    expect(() =>
      assertSafeTarget(root, join(root, "assets-local", "link", "photos"), "asset directory"),
    ).toThrow("symlinked path component");
  });

  it("rejects a lexically valid target outside the repository", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    expect(() => assertSafeTarget(root, outside, "asset directory")).toThrow(
      "outside the repository",
    );
  });
});

import { describe, expect, it } from "vitest";

import type { IdempotencyKeyRow } from "@/lib/db/schema";
import {
  hashRequest,
  replayIdempotent,
  stableStringify,
} from "@/lib/idempotency/service";

function storedRow(overrides: Partial<IdempotencyKeyRow> = {}): IdempotencyKeyRow {
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    key: crypto.randomUUID(),
    operation: "asset_import",
    requestHash: "a".repeat(64),
    responseStatus: 201,
    responseJson: { ok: true },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("idempotency hashing and replay", () => {
  it("hashes object keys independently of insertion order but preserves array order", () => {
    const first = { b: 2, a: 1, nested: { y: 2, x: 1 } };
    const second = { nested: { x: 1, y: 2 }, a: 1, b: 2 };
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(hashRequest(first)).toBe(hashRequest(second));
    expect(hashRequest({ items: [1, 2] })).not.toBe(hashRequest({ items: [2, 1] }));
  });

  it("replays a matching stored response", () => {
    const row = storedRow();
    expect(replayIdempotent(row, row.operation, row.requestHash)).toEqual({
      status: 201,
      body: { ok: true },
    });
  });

  it("returns null for a new key and rejects a changed payload", () => {
    expect(replayIdempotent(undefined, "asset_import", "a".repeat(64))).toBeNull();
    expect(() =>
      replayIdempotent(storedRow(), "asset_import", "b".repeat(64)),
    ).toThrow("The Idempotency-Key was already used with a different request.");
    expect(() =>
      replayIdempotent(storedRow(), "sample_import", "a".repeat(64)),
    ).toThrow("The Idempotency-Key was already used with a different request.");
  });
});

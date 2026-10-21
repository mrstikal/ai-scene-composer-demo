import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { sha256Hex } from "../assets/store";
import type { AppDatabase } from "../db/client";
import { idempotencyKeys, type IdempotencyKeyRow } from "../db/schema";
import { AppError } from "../errors";

export interface StoredIdempotentResponse {
  status: number;
  body: unknown;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      output[key] = normalizeForStableJson(source[key]);
    }
    return output;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export function hashRequest(value: unknown): string {
  return sha256Hex(Buffer.from(stableStringify(value), "utf8"));
}

export function findIdempotency(
  db: AppDatabase,
  projectId: string,
  key: string,
): IdempotencyKeyRow | undefined {
  return db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.projectId, projectId), eq(idempotencyKeys.key, key)))
    .get();
}

export function replayIdempotent(
  existing: IdempotencyKeyRow | undefined,
  operation: string,
  requestHash: string,
): StoredIdempotentResponse | null {
  if (existing === undefined) return null;
  if (existing.operation !== operation || existing.requestHash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "The Idempotency-Key was already used with a different request.",
    );
  }
  return {
    status: existing.responseStatus,
    body: existing.responseJson,
  };
}

export function insertIdempotency(
  db: AppDatabase,
  input: {
    projectId: string;
    key: string;
    operation: string;
    requestHash: string;
    response: StoredIdempotentResponse;
  },
): void {
  db.insert(idempotencyKeys)
    .values({
      id: randomUUID(),
      projectId: input.projectId,
      key: input.key,
      operation: input.operation,
      requestHash: input.requestHash,
      responseStatus: input.response.status,
      responseJson: input.response.body,
      createdAt: Date.now(),
    })
    .run();
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

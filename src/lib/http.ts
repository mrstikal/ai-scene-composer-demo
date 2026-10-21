import { z } from "zod";

import { assetRoleSchema, idempotencyKeySchema, type AssetRole } from "./contracts/api";
import { AppError, isAppError, toErrorPayload } from "./errors";

export const MAX_JSON_BYTES = 32 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
      ...headers,
    },
  });
}

export function errorResponse(error: unknown): Response {
  const { status, body } = toErrorPayload(error);
  return jsonResponse(body, status);
}

export async function route(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Buffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new AppError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
  }

  if (request.body === null) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AppError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError(400, "INVALID_REQUEST", "Expected an application/json request body.");
  }

  const bytes = await readBodyWithLimit(request, MAX_JSON_BYTES);
  if (bytes.length === 0) {
    throw new AppError(400, "INVALID_REQUEST", "Request body is required.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_REQUEST", "Request body is not valid JSON.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new AppError(400, "INVALID_REQUEST", `Invalid request body. ${path}${first?.message ?? ""}`.trim());
  }
  return parsed.data;
}

export function requireIdempotencyKey(request: Request): string {
  const header = request.headers.get("idempotency-key");
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_REQUEST", "A valid Idempotency-Key UUID header is required.");
  }
  return parsed.data;
}

export async function readMultipartForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError(400, "INVALID_REQUEST", "Expected a multipart/form-data request body.");
  }

  let bytes: Buffer;
  try {
    bytes = await readBodyWithLimit(request, MAX_MULTIPART_BYTES);
  } catch (error) {
    if (isAppError(error) && error.code === "REQUEST_TOO_LARGE") {
      throw new AppError(413, "UPLOAD_TOO_LARGE", "Upload body is too large.");
    }
    throw error;
  }

  if (bytes.length === 0) {
    throw new AppError(400, "INVALID_REQUEST", "Request body is required.");
  }

  try {
    return await new Response(new Uint8Array(bytes), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new AppError(400, "INVALID_REQUEST", "Malformed multipart request body.");
  }
}

export interface ParsedAssetForm {
  projectId: string;
  role: AssetRole;
  bytes: Buffer;
  declaredMimeType: string;
}

export async function parseAssetForm(form: FormData): Promise<ParsedAssetForm> {
  const allowed = new Set(["projectId", "role", "file"]);
  const fields = new Map<string, string>();
  let file: File | null = null;

  for (const [name, value] of form.entries()) {
    if (!allowed.has(name)) {
      throw new AppError(400, "INVALID_REQUEST", `Unknown multipart field: ${name}.`);
    }
    if (typeof value === "string") {
      if (fields.has(name)) {
        throw new AppError(400, "INVALID_REQUEST", `Duplicate multipart field: ${name}.`);
      }
      fields.set(name, value);
      continue;
    }
    if (name !== "file" || file !== null) {
      throw new AppError(400, "INVALID_REQUEST", "Exactly one file field is required.");
    }
    file = value;
  }

  const projectId = z.string().uuid().safeParse(fields.get("projectId"));
  if (!projectId.success) {
    throw new AppError(400, "INVALID_REQUEST", "A valid projectId field is required.");
  }

  const role = assetRoleSchema.safeParse(fields.get("role"));
  if (!role.success) {
    throw new AppError(400, "INVALID_REQUEST", "The role field must be base or reference.");
  }

  if (file === null) {
    throw new AppError(400, "INVALID_REQUEST", "A file field is required.");
  }
  if (file.size === 0) {
    throw new AppError(400, "INVALID_REQUEST", "The uploaded file is empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AppError(413, "UPLOAD_TOO_LARGE", "Uploaded file exceeds 10 MiB.");
  }

  return {
    projectId: projectId.data,
    role: role.data,
    bytes: Buffer.from(await file.arrayBuffer()),
    declaredMimeType: file.type,
  };
}

export function noStoreHeaders(): HeadersInit {
  return NO_STORE_HEADERS;
}

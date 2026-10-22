import sharp from "sharp";

import { mimeTypeForFormat } from "../assets/store";
import { inspectProviderImage } from "../images/normalize";
import {
  GENERATION_MODEL,
  type ImageGenerationResult,
  type ImageModel,
  type ImageResponseMetadata,
} from "./types";

export const OPENROUTER_IMAGES_ENDPOINT = "https://openrouter.ai/api/v1/images";
export const OPENROUTER_TIMEOUT_MS = 300_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface GenerationPayload {
  model: typeof GENERATION_MODEL;
  prompt: string;
  aspect_ratio: "1:1";
  quality: "medium";
  background: "opaque";
  n: 1;
  provider: {
    only: ["openai"];
    allow_fallbacks: false;
  };
}

export function buildGenerationPayload(prompt: string): GenerationPayload {
  return {
    model: GENERATION_MODEL,
    prompt,
    aspect_ratio: "1:1",
    quality: "medium",
    background: "opaque",
    n: 1,
    provider: {
      only: ["openai"],
      allow_fallbacks: false,
    },
  };
}

export interface EditPayload {
  model: ImageModel;
  prompt: string;
  aspect_ratio: "1:1";
  quality: "medium";
  background: "opaque";
  n: 1;
  provider: {
    only: ["openai"];
    allow_fallbacks: false;
  };
  input_references: Array<{
    type: "image_url";
    image_url: { url: string };
  }>;
}

export function buildEditPayload(input: {
  model: ImageModel;
  prompt: string;
  orderedInputImages: Buffer[];
}): EditPayload {
  if (input.orderedInputImages.length < 1 || input.orderedInputImages.length > 3) {
    throw new Error("Edits require the source image and zero to two references.");
  }

  return {
    model: input.model,
    prompt: input.prompt,
    aspect_ratio: "1:1",
    quality: "medium",
    background: "opaque",
    n: 1,
    provider: {
      only: ["openai"],
      allow_fallbacks: false,
    },
    input_references: input.orderedInputImages.map((bytes) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObservedCostUsdMicros(usage: Record<string, unknown> | null): number | null {
  const cost = usage?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  const micros = Math.round(cost * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function metadataFor(
  body: unknown,
  headers: Headers,
  latencyMs: number,
): ImageResponseMetadata {
  const record = isRecord(body) ? body : null;
  const usage = record !== null && isRecord(record.usage) ? record.usage : null;
  const requestId =
    headers.get("x-request-id") ??
    (record !== null && typeof record.id === "string" ? record.id : null);

  return {
    providerRequestId: requestId,
    usage,
    observedCostUsdMicros: parseObservedCostUsdMicros(usage),
    latencyMs,
  };
}

function invalidBase64(value: string): boolean {
  const normalized = value.replace(/\s/g, "");
  return (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  );
}

async function invalidWithBytes(
  bytes: Buffer,
  metadata: ImageResponseMetadata,
): Promise<ImageGenerationResult> {
  try {
    const info = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    const mimeType = mimeTypeForFormat(info.format);
    if (mimeType !== null && info.width !== undefined && info.height !== undefined) {
      return {
        kind: "invalid",
        message: "Provider returned an unusable image.",
        httpStatus: 200,
        bytes,
        mimeType,
        width: info.width,
        height: info.height,
        ...metadata,
      };
    }
  } catch {
    // The image is not inspectable; return the failure without raw bytes.
  }

  return {
    kind: "invalid",
    message: "Provider returned an unusable image.",
    httpStatus: 200,
    ...metadata,
  };
}

export async function parseOpenRouterImageResponse(input: {
  httpStatus: number;
  body: unknown;
  headers: Headers;
  latencyMs: number;
}): Promise<ImageGenerationResult> {
  const metadata = metadataFor(input.body, input.headers, input.latencyMs);

  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    if (isRecord(input.body) && isRecord(input.body.error)) {
      return {
        kind: "rejected",
        message: `OpenRouter rejected the request (HTTP ${input.httpStatus}).`,
        httpStatus: input.httpStatus,
        ...metadata,
      };
    }
    return {
      kind: "ambiguous",
      message: "OpenRouter returned an unidentifiable error response.",
      ...metadata,
    };
  }

  if (!isRecord(input.body) || !Array.isArray(input.body.data) || input.body.data.length !== 1) {
    return {
      kind: "invalid",
      message: "Provider response must contain exactly one image.",
      httpStatus: input.httpStatus,
      ...metadata,
    };
  }

  const entry = input.body.data[0];
  if (!isRecord(entry) || typeof entry.b64_json !== "string" || invalidBase64(entry.b64_json)) {
    return {
      kind: "invalid",
      message: "Provider response did not contain valid base64 image data.",
      httpStatus: input.httpStatus,
      ...metadata,
    };
  }

  const bytes = Buffer.from(entry.b64_json, "base64");
  if (bytes.length === 0) {
    return {
      kind: "invalid",
      message: "Provider response contained an empty image.",
      httpStatus: input.httpStatus,
      ...metadata,
    };
  }

  try {
    const inspected = await inspectProviderImage(bytes);
    if (typeof entry.media_type === "string" && entry.media_type !== inspected.mimeType) {
      return invalidWithBytes(bytes, metadata);
    }

    return {
      kind: "image",
      bytes,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      ...metadata,
    };
  } catch {
    return invalidWithBytes(bytes, metadata);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error("Provider response is too large.");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Provider response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function callOpenRouterImages(input: {
  apiKey: string;
  payload: unknown;
  fetchImpl?: typeof fetch;
}): Promise<ImageGenerationResult> {
  const startedAt = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(OPENROUTER_IMAGES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      cache: "no-store",
    });

    const text = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        return {
          kind: "ambiguous",
          message: "OpenRouter returned an unidentifiable non-JSON response.",
          providerRequestId: response.headers.get("x-request-id"),
          usage: null,
          observedCostUsdMicros: null,
          latencyMs: Date.now() - startedAt,
        };
      }
    }

    return parseOpenRouterImageResponse({
      httpStatus: response.status,
      body,
      headers: response.headers,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    const isTimeout =
      error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "ambiguous",
      message: isTimeout
        ? "OpenRouter request timed out before a definitive response."
        : "OpenRouter request failed before a definitive response.",
      providerRequestId: null,
      usage: null,
      observedCostUsdMicros: null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export async function callOpenRouterGeneration(input: {
  apiKey: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<ImageGenerationResult> {
  return callOpenRouterImages({
    apiKey: input.apiKey,
    payload: buildGenerationPayload(input.prompt),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
}

export async function callOpenRouterImage(input: {
  apiKey: string;
  model: ImageModel;
  prompt: string;
  orderedInputImages: Buffer[];
  fetchImpl?: typeof fetch;
}): Promise<ImageGenerationResult> {
  return callOpenRouterImages({
    apiKey: input.apiKey,
    payload: buildEditPayload({
      model: input.model,
      prompt: input.prompt,
      orderedInputImages: input.orderedInputImages,
    }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
}

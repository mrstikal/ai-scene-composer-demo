import OpenAI, { APIConnectionTimeoutError, APIError } from "openai";
import {
  buildObjectPrompt,
  InvalidSegmentationMaskError,
  parseImageStream,
  recordsOfKind,
  ResponsesStreamAbortedError,
  ResponsesStreamEventError,
  ResponsesStreamFailedError,
  ResponsesStreamLaneError,
  ResponsesStreamParserError,
  ResponsesStreamRefusalError,
  ResponsesStreamSourceError,
  type ResponsesEvent,
} from "@meta-sam/parser";

import {
  SAM_MODEL,
  type Point,
  type SamMaskRecord,
} from "../contracts/domain";
import { buildFullFrameMaskFromRecords, type FullFrameMask } from "../images/mask-pipeline";
import type {
  SegmentationAdapterInput,
  SegmentationAdapterResult,
  SegmentationResponseMetadata,
} from "./types";

export const META_SAM_BASE_URL = "https://api.meta.ai/v1";
export const META_SAM_TIMEOUT_MS = 120_000;

interface ObservedTerminal {
  completed: Record<string, unknown> | null;
  failed: boolean;
  streamError: boolean;
  incomplete: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObservedCostUsdMicros(usage: Record<string, unknown> | null): number | null {
  const cost = usage?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  const micros = Math.round(cost * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function metadataFromTerminal(
  terminal: ObservedTerminal,
  startedAt: number,
): SegmentationResponseMetadata {
  const usage = asRecord(terminal.completed?.usage);
  const providerRequestId =
    typeof terminal.completed?.id === "string" ? terminal.completed.id : null;
  const hasTerminal =
    terminal.completed !== null || terminal.failed || terminal.streamError || terminal.incomplete;

  return {
    providerRequestId,
    usage,
    observedCostUsdMicros: parseObservedCostUsdMicros(usage),
    latencyMs: hasTerminal ? Date.now() - startedAt : null,
  };
}

async function* observeEvents(
  source: AsyncIterable<ResponsesEvent>,
  terminal: ObservedTerminal,
): AsyncGenerator<ResponsesEvent> {
  for await (const event of source) {
    if (event.type === "response.completed") {
      terminal.completed = asRecord((event as { response?: unknown }).response);
    } else if (event.type === "response.failed") {
      terminal.failed = true;
    } else if (event.type === "response.incomplete") {
      terminal.incomplete = true;
    } else if (event.type === "error") {
      terminal.streamError = true;
    }
    yield event;
  }
}

function rejectedResult(
  message: string,
  metadata: SegmentationResponseMetadata,
): SegmentationAdapterResult {
  return {
    kind: "rejected",
    message,
    httpStatus: null,
    ...metadata,
  };
}

function invalidResult(
  message: string,
  metadata: SegmentationResponseMetadata,
): SegmentationAdapterResult {
  return {
    kind: "invalid",
    message,
    httpStatus: null,
    ...metadata,
  };
}

function ambiguousResult(
  message: string,
  metadata: SegmentationResponseMetadata,
  errorCode?: "PROVIDER_TIMEOUT" | "INTERRUPTED",
): SegmentationAdapterResult {
  return {
    kind: "ambiguous",
    message,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...metadata,
  };
}

function classifyParseError(
  error: unknown,
  terminal: ObservedTerminal,
  metadata: SegmentationResponseMetadata,
): SegmentationAdapterResult {
  if (error instanceof InvalidSegmentationMaskError) {
    return terminal.completed === null
      ? ambiguousResult("Meta SAM stream ended before a complete mask could be decoded.", metadata)
      : invalidResult("Meta SAM returned an invalid mask payload.", metadata);
  }
  if (error instanceof ResponsesStreamRefusalError) {
    return rejectedResult("Meta SAM refused the segmentation request.", metadata);
  }
  if (error instanceof ResponsesStreamFailedError) {
    return rejectedResult("Meta SAM rejected the segmentation request.", metadata);
  }
  if (error instanceof ResponsesStreamEventError) {
    return rejectedResult("Meta SAM stream reported an error.", metadata);
  }
  if (error instanceof ResponsesStreamSourceError) {
    return ambiguousResult("Meta SAM stream was interrupted.", metadata, "INTERRUPTED");
  }
  if (error instanceof ResponsesStreamAbortedError) {
    return ambiguousResult("Meta SAM stream was aborted before completion.", metadata);
  }
  if (error instanceof ResponsesStreamLaneError || error instanceof ResponsesStreamParserError) {
    return ambiguousResult("Meta SAM returned a malformed response stream.", metadata);
  }
  if (terminal.failed) {
    return rejectedResult("Meta SAM rejected the segmentation request.", metadata);
  }
  if (terminal.streamError) {
    return rejectedResult("Meta SAM stream reported an error.", metadata);
  }
  return ambiguousResult("Meta SAM stream ended without a definitive result.", metadata);
}

export function buildSamPrompt(input: {
  width: number;
  height: number;
  positivePoints: readonly Point[];
  negativePoints: readonly Point[];
}): string {
  return buildObjectPrompt({
    size: { width: input.width, height: input.height },
    objects: [
      {
        id: 1,
        prompts: [
          {
            points: [
              ...input.positivePoints.map((point) => ({ x: point.x, y: point.y })),
              ...input.negativePoints.map((point) => ({
                x: point.x,
                y: point.y,
                label: "negative" as const,
              })),
            ],
          },
        ],
      },
    ],
  });
}

export async function parseSamEvents(
  events: AsyncIterable<ResponsesEvent>,
  input: {
    width: number;
    height: number;
    positivePoints: readonly Point[];
    negativePoints: readonly Point[];
    startedAt?: number;
  },
): Promise<SegmentationAdapterResult> {
  const startedAt = input.startedAt ?? Date.now();
  const terminal: ObservedTerminal = {
    completed: null,
    failed: false,
    streamError: false,
    incomplete: false,
  };
  const parsed = parseImageStream(observeEvents(events, terminal));

  let result;
  try {
    result = await parsed.finalResult;
  } catch (error) {
    return classifyParseError(error, terminal, metadataFromTerminal(terminal, startedAt));
  }

  const metadata = metadataFromTerminal(terminal, startedAt);
  if (result.outcome.status !== "completed") {
    return ambiguousResult(
      result.outcome.reason === "response"
        ? "Meta SAM response was incomplete."
        : "Meta SAM stream ended before completion.",
      metadata,
      "INTERRUPTED",
    );
  }

  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return invalidResult("Meta SAM output contained parsing errors.", metadata);
  }

  const boxes = recordsOfKind(result.records, "box").filter((record) => record.objectId === "1");
  const masks = recordsOfKind(result.records, "mask").filter((record) => record.objectId === "1");
  if (boxes.length !== 1 || masks.length !== 1) {
    return invalidResult("Meta SAM did not return exactly one box and one mask for the prompt.", metadata);
  }

  const box = boxes[0];
  const mask = masks[0];
  if (box === undefined || mask === undefined) {
    return invalidResult("Meta SAM did not return the prompted object.", metadata);
  }

  const record: SamMaskRecord = {
    objectId: "1",
    box: {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    },
    bounds: {
      left: mask.bounds.left,
      top: mask.bounds.top,
      right: mask.bounds.right,
      bottom: mask.bounds.bottom,
    },
    mask: {
      encoding: mask.mask.encoding,
      payload: mask.mask.payload,
      width: mask.mask.width,
      height: mask.mask.height,
    },
  };

  let fullMask: FullFrameMask;
  try {
    fullMask = buildFullFrameMaskFromRecords({
      records: [record],
      frameWidth: input.width,
      frameHeight: input.height,
      positivePoints: input.positivePoints,
      negativePoints: input.negativePoints,
    });
  } catch (error) {
    return invalidResult(
      error instanceof Error ? error.message : "Meta SAM mask could not be validated.",
      metadata,
    );
  }

  return {
    kind: "mask",
    representation: "sam-records",
    records: [record],
    fullMask: fullMask.mask,
    width: fullMask.width,
    height: fullMask.height,
    ...metadata,
  };
}

function classifyTransportError(
  error: unknown,
  startedAt: number,
): SegmentationAdapterResult {
  const metadata: SegmentationResponseMetadata = {
    providerRequestId: null,
    observedCostUsdMicros: null,
    usage: null,
    latencyMs: Date.now() - startedAt,
  };

  if (error instanceof APIConnectionTimeoutError) {
    return ambiguousResult(
      "Meta SAM request timed out before a definitive response.",
      metadata,
      "PROVIDER_TIMEOUT",
    );
  }
  if (error instanceof APIError && typeof error.status === "number") {
    return rejectedResult(
      `Meta SAM rejected the request (HTTP ${error.status}).`,
      metadata,
    );
  }
  return ambiguousResult("Meta SAM request failed before a definitive response.", metadata);
}

export async function callMetaSam(
  input: SegmentationAdapterInput & { apiKey: string },
): Promise<SegmentationAdapterResult> {
  const startedAt = Date.now();
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: META_SAM_BASE_URL,
    timeout: META_SAM_TIMEOUT_MS,
    maxRetries: 0,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, META_SAM_TIMEOUT_MS);
  timer.unref();

  try {
    let stream: AsyncIterable<ResponsesEvent>;
    try {
      stream = (await client.responses.create(
        {
          model: SAM_MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: input.prompt },
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${input.image.toString("base64")}`,
                  detail: "auto",
                },
              ],
            },
          ],
          stream: true,
          metadata: { mask_encoding: "one_bit" },
        },
        { signal: controller.signal },
      )) as unknown as AsyncIterable<ResponsesEvent>;
    } catch (error) {
      if (timedOut) {
        return ambiguousResult(
          "Meta SAM request timed out before a definitive response.",
          {
            providerRequestId: null,
            usage: null,
            observedCostUsdMicros: null,
            latencyMs: Date.now() - startedAt,
          },
          "PROVIDER_TIMEOUT",
        );
      }
      return classifyTransportError(error, startedAt);
    }

    const parsed = parseSamEvents(stream, {
      width: input.width,
      height: input.height,
      positivePoints: input.positivePoints,
      negativePoints: input.negativePoints,
      startedAt,
    });
    const deadline = new Promise<SegmentationAdapterResult>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          resolve(
            ambiguousResult(
              "Meta SAM request timed out before a definitive response.",
              {
                providerRequestId: null,
                usage: null,
                observedCostUsdMicros: null,
                latencyMs: Date.now() - startedAt,
              },
              "PROVIDER_TIMEOUT",
            ),
          );
        },
        { once: true },
      );
    });

    return await Promise.race([parsed, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export const metaSamAdapter = {
  segment: (input: SegmentationAdapterInput & { apiKey: string }) => callMetaSam(input),
};

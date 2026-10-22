import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from "@meta-sam/parser";
import { afterEach, describe, expect, it } from "vitest";

import { samCaptureSchema, type SamCapture, type SamMaskRecord } from "@/lib/contracts/domain";
import {
  loadSamCapture,
  replaySamCapture,
  samFixtureStatusAtRoot,
  validateSamCapture,
} from "@/lib/sam/capture";
import documented from "@/test/fixtures/providers/sam/documented-complete-output-line.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function* eventStream(events: readonly ResponsesEvent[]): AsyncIterable<ResponsesEvent> {
  for (const event of events) yield event;
}

async function documentedObjectOneRecord(): Promise<SamMaskRecord> {
  const outputText = documented.outputText;
  const split = outputText.indexOf(",1<|box");
  const events: ResponsesEvent[] = [
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(0, split),
    },
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(split),
    },
    {
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    },
    { type: "response.completed" },
  ];
  const result = await parseImageStream(eventStream(events)).finalResult;
  const mask = recordsOfKind(result.records, "mask").find((record) => record.objectId === "1");
  const box = recordsOfKind(result.records, "box").find((record) => record.objectId === "1");
  if (mask === undefined || box === undefined) throw new Error("Documented object is missing.");
  return {
    objectId: "1",
    box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
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
}

async function syntheticCapture(): Promise<SamCapture> {
  return samCaptureSchema.parse({
    schemaVersion: 1,
    sourceKind: "captured-live",
    sourceCanonicalSha256: "a".repeat(64),
    width: 1024,
    height: 1024,
    normalizationVersion: "normalization-v1",
    positivePoints: [{ x: 180, y: 240 }],
    negativePoints: [],
    model: "sam-3.1",
    captureDate: "2026-10-22",
    providerRequestId: "req_documentation",
    providerLatencyMs: 12,
    observedCostUsdMicros: 2500,
    records: [await documentedObjectOneRecord()],
  });
}

describe("source-bound SAM capture validation", () => {
  it("accepts a capture bound to the same source, normalization, model and points", async () => {
    const capture = await syntheticCapture();
    expect(
      validateSamCapture(capture, {
        sourceSha256: "a".repeat(64),
        width: 1024,
        height: 1024,
        positivePoints: [{ x: 180, y: 240 }],
        negativePoints: [],
      }),
    ).toBeNull();

    const replay = replaySamCapture(capture);
    expect(replay.records).toHaveLength(1);
    expect(replay.fullMask.width).toBe(1024);
    expect(replay.fullMask.mask[240 * 1024 + 180]).toBe(1);
  });

  it("rejects mismatched source, points and model", async () => {
    const capture = await syntheticCapture();
    expect(
      validateSamCapture(capture, {
        sourceSha256: "b".repeat(64),
        width: 1024,
        height: 1024,
        positivePoints: [{ x: 180, y: 240 }],
        negativePoints: [],
      }),
    ).toContain("different source");
    expect(
      validateSamCapture(capture, {
        sourceSha256: "a".repeat(64),
        width: 1024,
        height: 1024,
        positivePoints: [{ x: 181, y: 240 }],
        negativePoints: [],
      }),
    ).toContain("positive point");
    expect(
      validateSamCapture(capture, {
        sourceSha256: "a".repeat(64),
        width: 1024,
        height: 1024,
        positivePoints: [{ x: 180, y: 240 }],
        negativePoints: [],
        model: "other",
      }),
    ).toContain("model");
  });

  it("rejects capture records that do not form a valid selection", async () => {
    const capture = await syntheticCapture();
    expect(
      validateSamCapture(
        {
          ...capture,
          records: capture.records.map((record) => ({ ...record, objectId: "0" })),
        },
        {
          sourceSha256: "a".repeat(64),
          width: 1024,
          height: 1024,
          positivePoints: [{ x: 180, y: 240 }],
          negativePoints: [],
        },
      ),
    ).toContain("valid completed segmentation");
  });

  it("reports missing fixtures without inventing a mask", async () => {
    const root = await mkdtemp(join(tmpdir(), "sam-fixture-test-"));
    temporaryDirectories.push(root);

    expect(
      loadSamCapture({
        repoRoot: root,
        sourceSha256: "a".repeat(64),
        width: 1024,
        height: 1024,
        positivePoints: [{ x: 180, y: 240 }],
        negativePoints: [],
      }),
    ).toEqual({ status: "missing" });

    const status = samFixtureStatusAtRoot(join(root, "src/test/fixtures"), "a".repeat(64));
    expect(status.ready).toBe(false);
    expect(status.reason).toContain("missing");
  });
});

import {
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from "@meta-sam/parser";
import { describe, expect, it } from "vitest";

import type { SamMaskRecord } from "@/lib/contracts/domain";
import {
  buildFullFrameMaskFromRecords,
  buildRegionMaskVariant,
  decodeAlphaPng,
  decodeMaskPng,
  dilateSquare,
  encodeAlphaPng,
  encodeMaskPng,
  featherAlpha,
  pasteCroppedMask,
  validateFullFrameMask,
  percentOfEdge,
} from "@/lib/images/mask-pipeline";
import documented from "@/test/fixtures/providers/sam/documented-complete-output-line.json";

async function* eventStream(events: readonly ResponsesEvent[]): AsyncIterable<ResponsesEvent> {
  for (const event of events) yield event;
}

async function documentedResult() {
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
  return parseImageStream(eventStream(events)).finalResult;
}

async function documentedObjectOneRecord(): Promise<SamMaskRecord> {
  const result = await documentedResult();
  expect(result.outcome.status).toBe("completed");
  expect(result.diagnostics).toEqual([]);
  const mask = recordsOfKind(result.records, "mask").find((record) => record.objectId === "1");
  const box = recordsOfKind(result.records, "box").find((record) => record.objectId === "1");
  expect(mask).toBeDefined();
  expect(box).toBeDefined();
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

function naiveDilate(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0;
      for (let ny = Math.max(0, y - radius); ny <= Math.min(height - 1, y + radius); ny += 1) {
        for (let nx = Math.max(0, x - radius); nx <= Math.min(width - 1, x + radius); nx += 1) {
          if (mask[ny * width + nx] === 1) on = 1;
        }
      }
      output[y * width + x] = on;
    }
  }
  return output;
}

function naiveFeather(
  allowed: Uint8Array,
  width: number,
  height: number,
  distance: number,
): Uint8Array {
  const output = new Uint8Array(allowed.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let valid = 0;
      for (let d = 1; d <= distance; d += 1) {
        let all = 1;
        for (let ny = Math.max(0, y - d); ny <= Math.min(height - 1, y + d); ny += 1) {
          for (let nx = Math.max(0, x - d); nx <= Math.min(width - 1, x + d); nx += 1) {
            if (allowed[ny * width + nx] !== 1) all = 0;
          }
        }
        valid += all;
      }
      output[y * width + x] = Math.round((255 * valid) / distance);
    }
  }
  return output;
}

describe("crop-to-canvas mask placement", () => {
  it("pastes a non-square crop at the exact half-open destination rectangle", () => {
    const raster = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const pasted = pasteCroppedMask({
      raster,
      bounds: { left: 4, top: 5, right: 7, bottom: 7 },
      frameWidth: 10,
      frameHeight: 10,
    });
    const at = (x: number, y: number) => pasted.mask[y * 10 + x];

    expect(at(4, 5)).toBe(1);
    expect(at(5, 5)).toBe(2);
    expect(at(6, 5)).toBe(3);
    expect(at(4, 6)).toBe(4);
    expect(at(5, 6)).toBe(5);
    expect(at(6, 6)).toBe(6);
    expect(at(3, 5)).toBe(0);
    expect(at(7, 5)).toBe(0);
    expect(at(4, 4)).toBe(0);
    expect(at(4, 7)).toBe(0);
  });

  it("rejects out-of-frame bounds and mismatched raster sizes", () => {
    expect(() =>
      pasteCroppedMask({
        raster: new Uint8Array(6),
        bounds: { left: 8, top: 0, right: 11, bottom: 2 },
        frameWidth: 10,
        frameHeight: 10,
      }),
    ).toThrow("inside the frame");

    expect(() =>
      pasteCroppedMask({
        raster: new Uint8Array(5),
        bounds: { left: 0, top: 0, right: 2, bottom: 2 },
        frameWidth: 10,
        frameHeight: 10,
      }),
    ).toThrow("do not match");
  });
});

describe("full-frame SAM mask validation", () => {
  it("pastes the documented object-1 crop into a 320 x 334 full frame", async () => {
    const record = await documentedObjectOneRecord();
    const full = buildFullFrameMaskFromRecords({
      records: [record],
      frameWidth: 320,
      frameHeight: 334,
      positive: { x: 180, y: 240 },
      negative: null,
    });

    expect(full.width).toBe(320);
    expect(full.height).toBe(334);
    expect(full.mask[240 * 320 + 180]).toBe(1);
    expect(full.mask[240 * 320 + 154]).toBe(0);
    expect(full.mask[240 * 320 + 203]).toBe(0);
    expect(full.mask[227 * 320 + 180]).toBe(0);
    expect(full.mask[255 * 320 + 180]).toBe(0);
  });

  it("rejects a positive point outside the mask and a negative point inside it", async () => {
    const record = await documentedObjectOneRecord();
    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [record],
        frameWidth: 320,
        frameHeight: 334,
        positive: { x: 10, y: 10 },
        negative: null,
      }),
    ).toThrow("positive point");

    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [record],
        frameWidth: 320,
        frameHeight: 334,
        positive: { x: 180, y: 240 },
        negative: { x: 180, y: 241 },
      }),
    ).toThrow("negative point");
  });

  it("rejects missing, duplicate, mismatched and out-of-bounds records", async () => {
    const record = await documentedObjectOneRecord();
    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [{ ...record, objectId: "0" }],
        frameWidth: 320,
        frameHeight: 334,
        positive: { x: 180, y: 240 },
        negative: null,
      }),
    ).toThrow("prompted object");

    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [record, { ...record }],
        frameWidth: 320,
        frameHeight: 334,
        positive: { x: 180, y: 240 },
        negative: null,
      }),
    ).toThrow("duplicate");

    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [{ ...record, bounds: { ...record.bounds, right: record.bounds.right + 1 } }],
        frameWidth: 320,
        frameHeight: 334,
        positive: { x: 180, y: 240 },
        negative: null,
      }),
    ).toThrow("do not agree");

    expect(() =>
      buildFullFrameMaskFromRecords({
        records: [record],
        frameWidth: 200,
        frameHeight: 200,
        positive: { x: 180, y: 150 },
        negative: null,
      }),
    ).toThrow("inside the frame");
  });

  it("rejects empty and non-binary full masks", () => {
    expect(() =>
      validateFullFrameMask({
        mask: new Uint8Array(4),
        width: 2,
        height: 2,
        positive: { x: 0, y: 0 },
        negative: null,
      }),
    ).toThrow("empty mask");

    expect(() =>
      validateFullFrameMask({
        mask: Uint8Array.from([0, 0, 2, 0]),
        width: 2,
        height: 2,
        positive: { x: 2, y: 2 },
        negative: null,
      }),
    ).toThrow("binary");
  });
});

describe("exact dilation and feather alpha", () => {
  it("matches a naive Chebyshev dilation for 16 and 32 pixel padding", () => {
    const width = 37;
    const height = 29;
    const mask = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = (index * 37 + 11) % 13 < 3 ? 1 : 0;
    }

    for (const radius of [0, 1, 3, 16, 32]) {
      expect(Array.from(dilateSquare(mask, width, height, radius))).toEqual(
        Array.from(naiveDilate(mask, width, height, radius)),
      );
    }
  });

  it("matches a naive eight-step inward feather and clips at the canvas edge", () => {
    const width = 41;
    const height = 31;
    const allowed = new Uint8Array(width * height);
    for (let index = 0; index < allowed.length; index += 1) {
      allowed[index] = (index * 19 + 5) % 11 < 5 ? 1 : 0;
    }
    expect(Array.from(featherAlpha(allowed, width, height, 8))).toEqual(
      Array.from(naiveFeather(allowed, width, height, 8)),
    );

    const full = new Uint8Array(10 * 10).fill(1);
    expect(Array.from(featherAlpha(full, 10, 10, 8))).toEqual(
      Array.from(new Uint8Array(10 * 10).fill(255)),
    );
  });

  it("builds both region variants with exact bounds and percentages", () => {
    const width = 100;
    const height = 100;
    const mask = new Uint8Array(width * height);
    mask[50 * width + 50] = 1;

    const variant = buildRegionMaskVariant(mask, width, height, 16);
    expect(variant.boundingBox).toEqual({ left: 34, top: 34, right: 67, bottom: 67 });
    expect(variant.percentages).toEqual({ left: 34, top: 34, right: 67, bottom: 67 });
    expect(variant.blendMask[50 * width + 34]).toBe(0);
    expect(variant.blendMask[50 * width + 35]).toBe(32);
    expect(variant.blendMask[50 * width + 42]).toBe(255);
    expect(variant.blendMask[50 * width + 50]).toBe(255);
    expect(percentOfEdge(1024, 1024)).toBe(100);
  });
});

describe("stored mask PNG encoding", () => {
  it("round-trips binary masks and alpha values as one-channel grayscale PNGs", async () => {
    const width = 4;
    const height = 2;
    const mask = Uint8Array.from([0, 1, 0, 1, 1, 0, 1, 0]);
    const maskPng = await encodeMaskPng(mask, width, height);
    const decodedMask = await decodeMaskPng(maskPng);
    expect(decodedMask).toEqual({ mask, width, height });

    const alpha = Uint8Array.from([0, 1, 32, 127, 128, 223, 254, 255]);
    const alphaPng = await encodeAlphaPng(alpha, width, height);
    const decodedAlpha = await decodeAlphaPng(alphaPng);
    expect(decodedAlpha).toEqual({ alpha, width, height });
  });
});

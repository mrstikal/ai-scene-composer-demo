import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  buildMockMask,
  imageModelForChannel,
  maskToGrayscalePng,
  mockEdit,
  mockGenerate,
  mockSegment,
} from "@/lib/providers/mocks";
import { createTestImage } from "@/test/helpers/environment";

async function firstPixel(bytes: Buffer): Promise<number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return Array.from(data.subarray(0, info.channels));
}

describe("deterministic mock adapters", () => {
  it("returns the committed synthetic 1024 generation fixture", async () => {
    const result = await mockGenerate({
      fixturePath: join(process.cwd(), "src/test/fixtures/synthetic/living-room-v1.png"),
      prompt: "ignored",
    });
    expect(result.kind).toBe("image");
    if (result.kind !== "image") throw new Error("Expected an image result.");
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.mimeType).toBe("image/png");
    expect(result.observedCostUsdMicros).toBe(0);
  });

  it("edits the red channel for Flare and the blue channel for Sunburst", async () => {
    const source = await createTestImage({
      width: 1024,
      height: 1024,
      background: { r: 10, g: 20, b: 30 },
    });

    const flare = await mockEdit({
      model: imageModelForChannel("red"),
      prompt: "ignored",
      orderedInputImages: [source],
    });
    if (flare.kind !== "image") throw new Error("Expected a mock edit image.");
    expect(await firstPixel(flare.bytes)).toEqual([50, 20, 30]);

    const sunburst = await mockEdit({
      model: imageModelForChannel("blue"),
      prompt: "ignored",
      orderedInputImages: [source],
    });
    if (sunburst.kind !== "image") throw new Error("Expected a mock edit image.");
    expect(await firstPixel(sunburst.bytes)).toEqual([10, 20, 70]);
  });

  it("builds a cropped centered mask with half-open bounds and clears a negative pixel", () => {
    const mask = buildMockMask({ positive: { x: 512, y: 512 }, negative: null });
    const count = mask.reduce((sum, value) => sum + value, 0);
    expect(count).toBe(129 * 129);

    const corrected = buildMockMask({
      positive: { x: 512, y: 512 },
      negative: { x: 520, y: 520 },
    });
    expect(corrected.reduce((sum, value) => sum + value, 0)).toBe(129 * 129 - 1);
    expect(corrected[520 * 1024 + 520]).toBe(0);

    const edge = buildMockMask({ positive: { x: 0, y: 0 }, negative: null });
    expect(edge.reduce((sum, value) => sum + value, 0)).toBe(65 * 65);

    const oppositeEdge = buildMockMask({ positive: { x: 1023, y: 1023 }, negative: null });
    expect(oppositeEdge.reduce((sum, value) => sum + value, 0)).toBe(65 * 65);
  });

  it("rejects identical or out-of-range points", () => {
    expect(() =>
      buildMockMask({ positive: { x: 10, y: 10 }, negative: { x: 10, y: 10 } }),
    ).toThrow("Positive and negative points must differ.");
    expect(() => buildMockMask({ positive: { x: 1024, y: 10 }, negative: null })).toThrow(
      "Positive point is outside the canonical image.",
    );
  });

  it("encodes a binary full-frame mask as 0/255 grayscale PNG", async () => {
    const mask = buildMockMask({ positive: { x: 512, y: 512 }, negative: null });
    const png = await maskToGrayscalePng(mask, 1024, 1024);
    const metadata = await sharp(png).metadata();
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(1024);
    expect(metadata.channels).toBe(1);

    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(data[(512 * 1024 + 512) * info.channels]).toBe(255);
    expect(data[0]).toBe(0);
  });

  it("runs the segmentation mock through the same geometry", async () => {
    const source = await createTestImage({ width: 1024, height: 1024 });
    const result = await mockSegment({
      image: source,
      width: 1024,
      height: 1024,
      positive: { x: 100, y: 100 },
      negative: null,
      prompt: "segment object 1",
    });
    if (result.kind !== "mask") throw new Error("Expected a mock mask.");
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.fullMask.reduce((sum, value) => sum + value, 0)).toBe(129 * 129);
  });
});

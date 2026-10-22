import { describe, expect, it } from "vitest";

import { compositeEdit } from "@/lib/images/composite";
import { decodeRgb } from "@/lib/images/normalize";
import { createTestImage } from "@/test/helpers/environment";

const SIZE = 1024 * 1024;

async function images() {
  const source = await createTestImage({
    width: 1024,
    height: 1024,
    background: { r: 10, g: 20, b: 30 },
  });
  const generated = await createTestImage({
    width: 1024,
    height: 1024,
    background: { r: 110, g: 120, b: 130 },
  });
  return { source, generated };
}

function masks(allowedValue: 0 | 1, blendValue: number) {
  return {
    allowedMask: new Uint8Array(SIZE).fill(allowedValue),
    blendMask: new Uint8Array(SIZE).fill(blendValue),
  };
}

describe("exact RGB composite", () => {
  it("copies source RGB at A=0 and reports raw background difference with zero final difference", async () => {
    const { source, generated } = await images();
    const result = await compositeEdit({
      sourceBytes: source,
      generatedBytes: generated,
      ...masks(0, 0),
    });

    expect(result.protectedPixelCount).toBe(SIZE);
    expect(result.rawBackgroundMae).toBeCloseTo(100, 10);
    expect(result.finalBackgroundMae).toBe(0);
    expect(result.protectedMismatchPixels).toBe(0);
    const decoded = await decodeRgb(result.bytes);
    expect(Array.from(decoded.data.subarray(0, 3))).toEqual([10, 20, 30]);
  });

  it("copies generated RGB at A=255 and keeps every protected pixel equal to source", async () => {
    const { source, generated } = await images();
    const { allowedMask, blendMask } = masks(0, 0);
    allowedMask[0] = 1;
    blendMask[0] = 255;
    const result = await compositeEdit({
      sourceBytes: source,
      generatedBytes: generated,
      allowedMask,
      blendMask,
    });

    expect(result.protectedPixelCount).toBe(SIZE - 1);
    expect(result.finalBackgroundMae).toBe(0);
    expect(result.protectedMismatchPixels).toBe(0);
    const decoded = await decodeRgb(result.bytes);
    expect(Array.from(decoded.data.subarray(0, 3))).toEqual([110, 120, 130]);
  });

  it("blends A with the exact integer rounding formula", async () => {
    const { source, generated } = await images();
    const { allowedMask, blendMask } = masks(0, 0);
    allowedMask[0] = 1;
    blendMask[0] = 128;
    const result = await compositeEdit({
      sourceBytes: source,
      generatedBytes: generated,
      allowedMask,
      blendMask,
    });

    const decoded = await decodeRgb(result.bytes);
    expect(Array.from(decoded.data.subarray(0, 3))).toEqual([60, 70, 80]);
  });

  it("allows an edit with no protected pixels and reports null MAEs", async () => {
    const { source, generated } = await images();
    const result = await compositeEdit({
      sourceBytes: source,
      generatedBytes: generated,
      ...masks(1, 255),
    });

    expect(result.protectedPixelCount).toBe(0);
    expect(result.rawBackgroundMae).toBeNull();
    expect(result.finalBackgroundMae).toBeNull();
    expect(result.protectedMismatchPixels).toBe(0);
    const decoded = await decodeRgb(result.bytes);
    expect(Array.from(decoded.data.subarray(0, 3))).toEqual([110, 120, 130]);
  });

  it("rejects non-binary allowed masks and alpha outside the allowed region", async () => {
    const { source, generated } = await images();
    const nonBinary = masks(0, 0);
    nonBinary.allowedMask[0] = 2;
    await expect(
      compositeEdit({
        sourceBytes: source,
        generatedBytes: generated,
        ...nonBinary,
      }),
    ).rejects.toThrow("binary");

    const alphaOutside = masks(0, 0);
    alphaOutside.blendMask[0] = 1;
    await expect(
      compositeEdit({
        sourceBytes: source,
        generatedBytes: generated,
        ...alphaOutside,
      }),
    ).rejects.toThrow("outside the allowed region");
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  assertSupportedMetadata,
  inspectImage,
  inspectProviderImage,
  MAX_INPUT_BYTES,
  normalizeBase,
  normalizeProviderImage,
  normalizeReference,
} from "@/lib/images/normalize";
import { createTestImage } from "@/test/helpers/environment";

async function firstPixel(bytes: Buffer): Promise<number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return Array.from(data.subarray(0, info.channels));
}

describe("image validation", () => {
  it("rejects unsupported formats and animated or oversized metadata", () => {
    expect(() => assertSupportedMetadata({ format: "gif", width: 10, height: 10 })).toThrow(
      "Only JPEG, PNG and WebP images are supported.",
    );
    expect(() =>
      assertSupportedMetadata({ format: "png", width: 10, height: 10, pages: 2 }),
    ).toThrow("Animated images are not supported.");
    expect(() => assertSupportedMetadata({ format: "png", width: 12_001, height: 1 })).toThrow(
      "Image exceeds the 12,000 pixel side limit.",
    );
    expect(() => assertSupportedMetadata({ format: "png", width: 7_000, height: 7_000 })).toThrow(
      "Image exceeds the 40 million pixel limit.",
    );
  });

  it("rejects malformed and oversized inputs", async () => {
    await expect(inspectImage(Buffer.from("not an image"))).rejects.toThrow(
      "Image is malformed or truncated.",
    );
    await expect(inspectImage(Buffer.alloc(MAX_INPUT_BYTES + 1))).rejects.toThrow(
      "Image file is too large.",
    );
  });

  it("rejects header-valid provider images whose pixels cannot be decoded during normalization", async () => {
    const valid = await createTestImage({ width: 1024, height: 1024 });
    const truncated = valid.subarray(0, Math.floor(valid.length * 0.6));
    await expect(inspectImage(truncated)).resolves.toBeDefined();
    await expect(inspectProviderImage(truncated)).resolves.toBeDefined();
    await expect(normalizeProviderImage(truncated)).rejects.toThrow(
      "Provider image could not be normalized.",
    );
  });

  it("accepts JPEG, PNG and WebP by decoded format", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const bytes = await createTestImage({ width: 50, height: 50, format });
      const inspected = await inspectImage(bytes);
      expect(inspected.mimeType).toBe(`image/${format === "jpeg" ? "jpeg" : format}`);
    }
  });
});

describe("base normalization", () => {
  it("contains a landscape image in a square with neutral padding", async () => {
    const bytes = await createTestImage({
      width: 200,
      height: 100,
      background: { r: 255, g: 0, b: 0 },
    });
    const normalized = await normalizeBase(bytes);
    expect(normalized.width).toBe(1024);
    expect(normalized.height).toBe(1024);
    expect(normalized.mimeType).toBe("image/png");
    expect(await firstPixel(normalized.bytes)).toEqual([240, 240, 240]);
  });

  it("contains a portrait image in a square", async () => {
    const bytes = await createTestImage({
      width: 100,
      height: 200,
      background: { r: 0, g: 255, b: 0 },
    });
    const normalized = await normalizeBase(bytes);
    expect(normalized.width).toBe(1024);
    expect(normalized.height).toBe(1024);
  });

  it("flattens transparent pixels over #F0F0F0 and removes alpha", async () => {
    const bytes = await createTestImage({
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    });
    const normalized = await normalizeBase(bytes);
    const { info } = await sharp(normalized.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(await firstPixel(normalized.bytes)).toEqual([240, 240, 240]);
  });
});

describe("reference normalization", () => {
  it("preserves aspect ratio without padding or enlargement", async () => {
    const small = await createTestImage({ width: 200, height: 100 });
    const normalizedSmall = await normalizeReference(small);
    expect(normalizedSmall.width).toBe(200);
    expect(normalizedSmall.height).toBe(100);

    const large = await createTestImage({ width: 2000, height: 1000 });
    const normalizedLarge = await normalizeReference(large);
    expect(normalizedLarge.width).toBe(1024);
    expect(normalizedLarge.height).toBe(512);
  });

  it("applies EXIF orientation before reading effective dimensions", async () => {
    const bytes = await createTestImage({
      width: 40,
      height: 20,
      format: "jpeg",
      orientation: 6,
    });
    const inspected = await inspectImage(bytes);
    expect(inspected.width).toBe(20);
    expect(inspected.height).toBe(40);

    const normalized = await normalizeReference(bytes);
    expect(normalized.width).toBe(20);
    expect(normalized.height).toBe(40);
  });
});

describe("provider image normalization", () => {
  it("accepts a square 512 image and normalizes it to 1024", async () => {
    const bytes = await createTestImage({ width: 512, height: 512 });
    const normalized = await normalizeProviderImage(bytes);
    expect(normalized.width).toBe(1024);
    expect(normalized.height).toBe(1024);
  });

  it("rejects non-square and out-of-range provider images", async () => {
    const nonSquare = await createTestImage({ width: 1024, height: 512 });
    await expect(normalizeProviderImage(nonSquare)).rejects.toThrow(
      "Provider image must be square.",
    );

    const tooSmall = await createTestImage({ width: 400, height: 400 });
    await expect(normalizeProviderImage(tooSmall)).rejects.toThrow(
      "Provider image side must be between 512 and 4096 pixels.",
    );
  });
});

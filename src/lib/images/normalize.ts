import sharp from "sharp";

import { mimeTypeForFormat, sha256Hex, type AssetMimeType } from "../assets/store";
import { AppError } from "../errors";

export const NORMALIZATION_VERSION = "normalization-v1";
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_PROVIDER_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export const MAX_INPUT_SIDE = 12_000;
export const CANONICAL_SIZE = 1024;

export interface InspectedImage {
  format: "jpeg" | "png" | "webp";
  mimeType: AssetMimeType;
  width: number;
  height: number;
  pages: number;
  orientation: number;
}

export interface ImageMetadataLike {
  format?: string;
  width?: number;
  height?: number;
  pages?: number;
  orientation?: number;
}

export function assertSupportedMetadata(metadata: ImageMetadataLike): InspectedImage {
  const mimeType = mimeTypeForFormat(metadata.format);
  if (mimeType === null) {
    throw new AppError(415, "UNSUPPORTED_IMAGE_TYPE", "Only JPEG, PNG and WebP images are supported.");
  }

  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new AppError(422, "INVALID_IMAGE", "Image dimensions are invalid.");
  }
  if (width > MAX_INPUT_SIDE || height > MAX_INPUT_SIDE) {
    throw new AppError(422, "INVALID_IMAGE", "Image exceeds the 12,000 pixel side limit.");
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw new AppError(422, "INVALID_IMAGE", "Image exceeds the 40 million pixel limit.");
  }

  const pages = metadata.pages ?? 1;
  if (pages > 1) {
    throw new AppError(422, "INVALID_IMAGE", "Animated images are not supported.");
  }

  const orientation = metadata.orientation ?? 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;

  return {
    format: metadata.format as "jpeg" | "png" | "webp",
    mimeType,
    width: swapsAxes ? height : width,
    height: swapsAxes ? width : height,
    pages,
    orientation,
  };
}

export async function inspectImage(
  bytes: Buffer,
  options: { maxBytes?: number } = {},
): Promise<InspectedImage> {
  assertImageBytes(bytes, options.maxBytes ?? MAX_INPUT_BYTES);

  let metadata: ImageMetadataLike;
  try {
    metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new AppError(422, "INVALID_IMAGE", "Image is malformed or truncated.");
  }

  return assertSupportedMetadata(metadata);
}

function assertImageBytes(bytes: Buffer, maxBytes: number): void {
  if (bytes.length === 0) {
    throw new AppError(422, "INVALID_IMAGE", "Image is empty.");
  }
  if (bytes.length > maxBytes) {
    throw new AppError(413, "UPLOAD_TOO_LARGE", "Image file is too large.");
  }
}

export interface NormalizedImage {
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: "image/png";
  sha256: string;
  normalizationVersion: typeof NORMALIZATION_VERSION;
}

function normalizedResult(data: Buffer, info: { width: number; height: number }): NormalizedImage {
  return {
    bytes: data,
    width: info.width,
    height: info.height,
    mimeType: "image/png",
    sha256: sha256Hex(data),
    normalizationVersion: NORMALIZATION_VERSION,
  };
}

export async function normalizeBase(
  bytes: Buffer,
  inspected?: InspectedImage,
): Promise<NormalizedImage> {
  if (inspected === undefined) {
    await inspectImage(bytes);
  } else {
    assertImageBytes(bytes, MAX_INPUT_BYTES);
  }

  try {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: "#F0F0F0" })
      .resize({
        width: CANONICAL_SIZE,
        height: CANONICAL_SIZE,
        fit: "contain",
        position: "centre",
        background: "#F0F0F0",
      })
      .removeAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer({ resolveWithObject: true });

    return normalizedResult(data, info);
  } catch {
    throw new AppError(422, "INVALID_IMAGE", "Image could not be normalized.");
  }
}

export async function normalizeReference(
  bytes: Buffer,
  inspected?: InspectedImage,
): Promise<NormalizedImage> {
  if (inspected === undefined) {
    await inspectImage(bytes);
  } else {
    assertImageBytes(bytes, MAX_INPUT_BYTES);
  }

  try {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: "#F0F0F0" })
      .resize({
        width: CANONICAL_SIZE,
        height: CANONICAL_SIZE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer({ resolveWithObject: true });

    return normalizedResult(data, info);
  } catch {
    throw new AppError(422, "INVALID_IMAGE", "Reference image could not be normalized.");
  }
}

export async function inspectProviderImage(bytes: Buffer): Promise<InspectedImage> {
  const inspected = await inspectImage(bytes, { maxBytes: MAX_PROVIDER_IMAGE_BYTES });
  if (inspected.width !== inspected.height) {
    throw new AppError(422, "INVALID_IMAGE", "Provider image must be square.");
  }
  if (inspected.width < 512 || inspected.width > 4096) {
    throw new AppError(422, "INVALID_IMAGE", "Provider image side must be between 512 and 4096 pixels.");
  }
  return inspected;
}

export async function normalizeProviderImage(bytes: Buffer): Promise<NormalizedImage> {
  await inspectProviderImage(bytes);

  try {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: "#F0F0F0" })
      .resize({
        width: CANONICAL_SIZE,
        height: CANONICAL_SIZE,
        fit: "fill",
        kernel: "lanczos3",
      })
      .removeAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer({ resolveWithObject: true });

    return normalizedResult(data, info);
  } catch {
    throw new AppError(422, "INVALID_IMAGE", "Provider image could not be normalized.");
  }
}

export async function decodeRgb(bytes: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  await inspectImage(bytes, { maxBytes: MAX_PROVIDER_IMAGE_BYTES });

  try {
    const { data, info } = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: "#F0F0F0" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 3) {
      throw new AppError(422, "INVALID_IMAGE", "Image did not decode to RGB.");
    }
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "INVALID_IMAGE", "Image could not be decoded.");
  }
}

export async function encodeRgbPng(data: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(data, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

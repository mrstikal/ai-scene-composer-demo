import { readFile } from "node:fs/promises";

import { AppError } from "../errors";
import {
  CANONICAL_SIZE,
  decodeRgb,
  encodeRgbPng,
  inspectImage,
  inspectProviderImage,
} from "../images/normalize";
import {
  encodeMaskPng,
  pasteCroppedMask,
  validateFullFrameMask,
} from "../images/mask-pipeline";
import type {
  ImageAdapterInput,
  ImageAdapterResult,
  ImageGenerationResult,
  ImageModel,
  SegmentationAdapterInput,
  SegmentationAdapterResult,
} from "./types";

export async function mockGenerate(input: {
  fixturePath: string;
  prompt: string;
}): Promise<ImageGenerationResult> {
  const bytes = await readFile(input.fixturePath);
  const inspected = await inspectProviderImage(bytes);
  if (inspected.width !== CANONICAL_SIZE || inspected.height !== CANONICAL_SIZE) {
    throw new AppError(500, "CONFIG_INVALID", "Synthetic generation fixture must be 1024 x 1024.");
  }

  return {
    kind: "image",
    bytes,
    mimeType: inspected.mimeType,
    width: inspected.width,
    height: inspected.height,
    providerRequestId: null,
    observedCostUsdMicros: 0,
    usage: null,
    latencyMs: null,
  };
}

export async function mockEdit(input: ImageAdapterInput): Promise<ImageAdapterResult> {
  if (input.orderedInputImages.length < 1 || input.orderedInputImages.length > 3) {
    throw new AppError(400, "INVALID_REQUEST", "Mock edit expects one to three ordered input images.");
  }

  const source = input.orderedInputImages[0];
  if (source === undefined) {
    throw new AppError(400, "INVALID_REQUEST", "Mock edit requires a source image.");
  }

  await inspectImage(source);
  const decoded = await decodeRgb(source);
  const output = Buffer.from(decoded.data);
  const channelIndex = input.model === "openai/gpt-image-2.5-flare" ? 0 : 2;

  for (let index = 0; index < output.length; index += 3) {
    output[index + channelIndex] = (output[index + channelIndex] + 40) % 256;
  }

  const bytes = await encodeRgbPng(output, decoded.width, decoded.height);
  const inspected = await inspectProviderImage(bytes);

  return {
    kind: "image",
    bytes,
    mimeType: "image/png",
    width: inspected.width,
    height: inspected.height,
    providerRequestId: null,
    observedCostUsdMicros: 0,
    usage: null,
    latencyMs: null,
  };
}

export function buildMockMask(input: {
  positive: { x: number; y: number };
  negative: { x: number; y: number } | null;
  size?: number;
}): Uint8Array {
  const size = input.size ?? CANONICAL_SIZE;
  const { positive, negative } = input;

  if (
    !Number.isInteger(positive.x) ||
    !Number.isInteger(positive.y) ||
    positive.x < 0 ||
    positive.y < 0 ||
    positive.x >= size ||
    positive.y >= size
  ) {
    throw new AppError(400, "INVALID_POINT", "Positive point is outside the canonical image.");
  }
  if (negative !== null) {
    if (
      !Number.isInteger(negative.x) ||
      !Number.isInteger(negative.y) ||
      negative.x < 0 ||
      negative.y < 0 ||
      negative.x >= size ||
      negative.y >= size
    ) {
      throw new AppError(400, "INVALID_POINT", "Negative point is outside the canonical image.");
    }
    if (negative.x === positive.x && negative.y === positive.y) {
      throw new AppError(400, "INVALID_POINT", "Positive and negative points must differ.");
    }
  }

  const left = Math.max(0, positive.x - 64);
  const right = Math.min(size, positive.x + 65);
  const top = Math.max(0, positive.y - 64);
  const bottom = Math.min(size, positive.y + 65);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const raster = new Uint8Array(cropWidth * cropHeight).fill(1);

  if (
    negative !== null &&
    negative.x >= left &&
    negative.x < right &&
    negative.y >= top &&
    negative.y < bottom
  ) {
    raster[(negative.y - top) * cropWidth + (negative.x - left)] = 0;
  }

  const pasted = pasteCroppedMask({
    raster,
    bounds: { left, top, right, bottom },
    frameWidth: size,
    frameHeight: size,
  });
  validateFullFrameMask({
    mask: pasted.mask,
    width: size,
    height: size,
    positive,
    negative,
  });
  return pasted.mask;
}

export async function mockSegment(input: SegmentationAdapterInput): Promise<SegmentationAdapterResult> {
  if (input.width !== input.height) {
    throw new AppError(500, "CONFIG_INVALID", "Mock segmentation requires a square canonical image.");
  }
  await inspectImage(input.image);
  const fullMask = buildMockMask({
    positive: input.positive,
    negative: input.negative,
    size: input.width,
  });

  return {
    kind: "mask",
    representation: "full-mask",
    fullMask,
    width: input.width,
    height: input.height,
    providerRequestId: null,
    observedCostUsdMicros: 0,
    usage: null,
    latencyMs: null,
  };
}

export async function maskToGrayscalePng(mask: Uint8Array, width: number, height: number): Promise<Buffer> {
  return encodeMaskPng(mask, width, height);
}

export function imageModelForChannel(channel: "red" | "blue"): ImageModel {
  return channel === "red"
    ? "openai/gpt-image-2.5-flare"
    : "openai/gpt-image-2.5-sunburst";
}

import { readFile } from "node:fs/promises";

import { AppError } from "../errors";
import type { Point } from "../contracts/domain";
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
  positivePoints: readonly Point[];
  negativePoints: readonly Point[];
  size?: number;
}): Uint8Array {
  const size = input.size ?? CANONICAL_SIZE;
  const { positivePoints, negativePoints } = input;

  if (positivePoints.length === 0) {
    throw new AppError(400, "INVALID_POINT", "At least one positive point is required.");
  }

  const seen = new Map<string, "positive" | "negative">();
  for (const [label, points] of [
    ["positive", positivePoints],
    ["negative", negativePoints],
  ] as const) {
    for (const point of points) {
      if (
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x >= size ||
        point.y >= size
      ) {
        throw new AppError(
          400,
          "INVALID_POINT",
          `${label === "positive" ? "Positive" : "Negative"} point is outside the canonical image.`,
        );
      }
      const key = `${point.x},${point.y}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        throw new AppError(
          400,
          "INVALID_POINT",
          existing === label
            ? "Points must be unique."
            : "Positive and negative points must differ.",
        );
      }
      seen.set(key, label);
    }
  }

  let left = size;
  let right = 0;
  let top = size;
  let bottom = 0;
  for (const point of positivePoints) {
    left = Math.min(left, point.x - 64);
    right = Math.max(right, point.x + 65);
    top = Math.min(top, point.y - 64);
    bottom = Math.max(bottom, point.y + 65);
  }
  left = Math.max(0, left);
  right = Math.min(size, right);
  top = Math.max(0, top);
  bottom = Math.min(size, bottom);

  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const raster = new Uint8Array(cropWidth * cropHeight).fill(1);

  for (const negative of negativePoints) {
    if (
      negative.x >= left &&
      negative.x < right &&
      negative.y >= top &&
      negative.y < bottom
    ) {
      raster[(negative.y - top) * cropWidth + (negative.x - left)] = 0;
    }
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
    positivePoints,
    negativePoints,
  });
  return pasted.mask;
}

export async function mockSegment(input: SegmentationAdapterInput): Promise<SegmentationAdapterResult> {
  if (input.width !== input.height) {
    throw new AppError(500, "CONFIG_INVALID", "Mock segmentation requires a square canonical image.");
  }
  await inspectImage(input.image);
  const fullMask = buildMockMask({
    positivePoints: input.positivePoints,
    negativePoints: input.negativePoints,
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

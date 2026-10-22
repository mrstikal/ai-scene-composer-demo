import { decodeMaskToRaster } from "@meta-sam/parser";
import sharp from "sharp";

import {
  MASK_FEATHER_PX,
  type Bounds,
  type MaskPaddingPx,
  type Point,
  type SamMaskRecord,
} from "../contracts/domain";
import { AppError } from "../errors";

export interface FullFrameMask {
  mask: Uint8Array;
  width: number;
  height: number;
}

function invalid(message: string): never {
  throw new AppError(422, "INVALID_SELECTION", message);
}

function assertMaskShape(values: Uint8Array, width: number, height: number): void {
  if (width <= 0 || height <= 0) invalid("Mask dimensions must be positive.");
  if (values.length !== width * height) invalid("Mask dimensions do not match its pixel count.");
}

function assertBounds(bounds: Bounds, frameWidth: number, frameHeight: number): void {
  if (
    bounds.left < 0 ||
    bounds.top < 0 ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top ||
    bounds.right > frameWidth ||
    bounds.bottom > frameHeight
  ) {
    invalid("Mask bounds must be a non-empty half-open rectangle inside the frame.");
  }
}

function sameBounds(left: Bounds, right: Bounds): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
}

export function pasteCroppedMask(input: {
  raster: Uint8Array;
  bounds: Bounds;
  frameWidth: number;
  frameHeight: number;
}): FullFrameMask {
  const { raster, bounds, frameWidth, frameHeight } = input;
  assertBounds(bounds, frameWidth, frameHeight);

  const cropWidth = bounds.right - bounds.left;
  const cropHeight = bounds.bottom - bounds.top;
  if (raster.length !== cropWidth * cropHeight) {
    invalid("Cropped mask dimensions do not match its pixel count.");
  }

  const mask = new Uint8Array(frameWidth * frameHeight);
  for (let row = 0; row < cropHeight; row += 1) {
    const sourceStart = row * cropWidth;
    const targetStart = (bounds.top + row) * frameWidth + bounds.left;
    mask.set(raster.subarray(sourceStart, sourceStart + cropWidth), targetStart);
  }

  return { mask, width: frameWidth, height: frameHeight };
}

export function validateFullFrameMask(input: {
  mask: Uint8Array;
  width: number;
  height: number;
  positive: Point;
  negative: Point | null;
}): void {
  const { mask, width, height, positive, negative } = input;
  assertMaskShape(mask, width, height);

  let onPixels = 0;
  for (const value of mask) {
    if (value !== 0 && value !== 1) invalid("SAM mask values must be binary.");
    onPixels += value;
  }
  if (onPixels === 0) invalid("SAM returned an empty mask.");

  if (positive.x >= width || positive.y >= height) invalid("The positive point is outside the image.");
  if (mask[positive.y * width + positive.x] !== 1) {
    invalid("The positive point is not covered by the SAM mask.");
  }

  if (negative !== null) {
    if (negative.x >= width || negative.y >= height) {
      invalid("The negative point is outside the image.");
    }
    if (mask[negative.y * width + negative.x] !== 0) {
      invalid("The negative point is covered by the SAM mask.");
    }
  }
}

export function buildFullFrameMaskFromRecords(input: {
  records: readonly SamMaskRecord[];
  frameWidth: number;
  frameHeight: number;
  positive: Point;
  negative: Point | null;
}): FullFrameMask {
  const { records, frameWidth, frameHeight, positive, negative } = input;
  const objectRecords = records.filter((record) => record.objectId === "1");
  if (objectRecords.length === 0) invalid("SAM did not return the prompted object.");
  if (objectRecords.length > 1) invalid("SAM returned duplicate records for the prompted object.");

  const record = objectRecords[0];
  if (record === undefined) invalid("SAM did not return the prompted object.");
  if (!sameBounds(record.box, record.bounds)) {
    invalid("SAM box and mask bounds do not agree.");
  }
  assertBounds(record.box, frameWidth, frameHeight);

  const cropWidth = record.box.right - record.box.left;
  const cropHeight = record.box.bottom - record.box.top;
  if (record.mask.width !== cropWidth || record.mask.height !== cropHeight) {
    invalid("SAM mask raster dimensions do not match its box.");
  }

  let raster: Uint8Array;
  try {
    raster = decodeMaskToRaster({
      encoding: record.mask.encoding,
      payload: record.mask.payload,
      width: record.mask.width,
      height: record.mask.height,
    });
  } catch {
    invalid("SAM returned an invalid mask payload.");
  }

  const pasted = pasteCroppedMask({
    raster,
    bounds: record.box,
    frameWidth,
    frameHeight,
  });
  validateFullFrameMask({
    mask: pasted.mask,
    width: pasted.width,
    height: pasted.height,
    positive,
    negative,
  });
  return pasted;
}

function buildSummedAreaTable(mask: Uint8Array, width: number, height: number): Uint32Array {
  const stride = width + 1;
  const sat = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const rowBase = (y + 1) * stride;
    const previousBase = y * stride;
    const maskBase = y * width;
    for (let x = 0; x < width; x += 1) {
      rowSum += mask[maskBase + x] === 1 ? 1 : 0;
      sat[rowBase + x + 1] = sat[previousBase + x + 1] + rowSum;
    }
  }
  return sat;
}

function rectangleSum(
  sat: Uint32Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  return sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];
}

export function dilateSquare(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  assertMaskShape(mask, width, height);
  if (!Number.isSafeInteger(radius) || radius < 0) invalid("Dilation radius must be nonnegative.");
  if (radius === 0) return mask.slice();

  const stride = width + 1;
  const sat = buildSummedAreaTable(mask, width, height);
  const output = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      if (rectangleSum(sat, stride, x0, y0, x1, y1) > 0) {
        output[y * width + x] = 1;
      }
    }
  }
  return output;
}

export function featherAlpha(
  allowedMask: Uint8Array,
  width: number,
  height: number,
  featherPx: number = MASK_FEATHER_PX,
): Uint8Array {
  assertMaskShape(allowedMask, width, height);
  if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > 255) {
    invalid("Feather distance must be a small nonnegative integer.");
  }

  const alpha = new Uint8Array(allowedMask.length);
  if (featherPx === 0) {
    for (let index = 0; index < allowedMask.length; index += 1) {
      alpha[index] = allowedMask[index] === 1 ? 255 : 0;
    }
    return alpha;
  }

  const stride = width + 1;
  const sat = buildSummedAreaTable(allowedMask, width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (allowedMask[index] === 0) continue;

      let validErodes = 0;
      for (let distance = 1; distance <= featherPx; distance += 1) {
        const x0 = Math.max(0, x - distance);
        const y0 = Math.max(0, y - distance);
        const x1 = Math.min(width, x + distance + 1);
        const y1 = Math.min(height, y + distance + 1);
        const area = (x1 - x0) * (y1 - y0);
        if (rectangleSum(sat, stride, x0, y0, x1, y1) === area) validErodes += 1;
      }
      alpha[index] = Math.round((255 * validErodes) / featherPx);
    }
  }
  return alpha;
}

export function boundingBoxOf(mask: Uint8Array, width: number, height: number): Bounds | null {
  assertMaskShape(mask, width, height);
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== 1) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }

  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

export function percentOfEdge(value: number, size: number): number {
  if (size <= 0) invalid("Image size must be positive.");
  return Math.round((value * 1000) / size) / 10;
}

export interface RegionMaskVariant {
  allowedMask: Uint8Array;
  blendMask: Uint8Array;
  boundingBox: Bounds;
  percentages: { left: number; top: number; right: number; bottom: number };
}

export function buildRegionMaskVariant(
  mask: Uint8Array,
  width: number,
  height: number,
  paddingPx: MaskPaddingPx,
): RegionMaskVariant {
  const allowedMask = dilateSquare(mask, width, height, paddingPx);
  const blendMask = featherAlpha(allowedMask, width, height, MASK_FEATHER_PX);
  const boundingBox = boundingBoxOf(allowedMask, width, height);
  if (boundingBox === null) invalid("Allowed region is empty.");

  return {
    allowedMask,
    blendMask,
    boundingBox,
    percentages: {
      left: percentOfEdge(boundingBox.left, width),
      top: percentOfEdge(boundingBox.top, height),
      right: percentOfEdge(boundingBox.right, width),
      bottom: percentOfEdge(boundingBox.bottom, height),
    },
  };
}

export async function encodeMaskPng(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  assertMaskShape(mask, width, height);
  const values = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 0 && mask[index] !== 1) invalid("Mask values must be binary.");
    values[index] = mask[index] === 1 ? 255 : 0;
  }
  return sharp(Buffer.from(values), { raw: { width, height, channels: 1 } })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function encodeAlphaPng(
  alpha: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  assertMaskShape(alpha, width, height);
  return sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function decodeMaskPng(
  bytes: Buffer,
): Promise<{ mask: Uint8Array; width: number; height: number }> {
  const raw = await decodeGrayscalePng(bytes);
  const mask = new Uint8Array(raw.values.length);
  for (let index = 0; index < raw.values.length; index += 1) {
    const value = raw.values[index];
    if (value !== 0 && value !== 255) invalid("Stored mask PNG is not binary.");
    mask[index] = value === 255 ? 1 : 0;
  }
  return { mask, width: raw.width, height: raw.height };
}

export async function decodeAlphaPng(
  bytes: Buffer,
): Promise<{ alpha: Uint8Array; width: number; height: number }> {
  const raw = await decodeGrayscalePng(bytes);
  return { alpha: raw.values, width: raw.width, height: raw.height };
}

async function decodeGrayscalePng(
  bytes: Buffer,
): Promise<{ values: Uint8Array; width: number; height: number }> {
  try {
    const decoded = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 })
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decoded.info.channels !== 1) invalid("Stored mask PNG must have one channel.");
    return {
      values: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("Stored mask PNG could not be decoded.");
  }
}

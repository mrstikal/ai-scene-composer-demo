import {
  COMPOSITE_PIPELINE_VERSION,
  MASK_PIPELINE_VERSION,
  type EditMetrics,
} from "../contracts/domain";
import { AppError } from "../errors";
import { CANONICAL_SIZE, decodeRgb, encodeRgbPng } from "./normalize";

export interface CompositeResult extends EditMetrics {
  bytes: Buffer;
  width: number;
  height: number;
}

function invalid(message: string): never {
  throw new AppError(422, "INVALID_SELECTION", message);
}

function validateMasks(
  allowedMask: Uint8Array,
  blendMask: Uint8Array,
  pixelCount: number,
): void {
  if (allowedMask.length !== pixelCount || blendMask.length !== pixelCount) {
    invalid("Region masks do not match the canonical pixel count.");
  }
  for (let index = 0; index < pixelCount; index += 1) {
    const allowed = allowedMask[index];
    const alpha = blendMask[index];
    if (allowed !== 0 && allowed !== 1) invalid("Allowed region mask must be binary.");
    if (alpha === undefined || alpha < 0 || alpha > 255) {
      invalid("Blend alpha mask contains an invalid value.");
    }
    if (allowed === 0 && alpha !== 0) {
      invalid("Blend alpha must be zero outside the allowed region.");
    }
  }
}

export async function compositeEdit(input: {
  sourceBytes: Buffer;
  generatedBytes: Buffer;
  allowedMask: Uint8Array;
  blendMask: Uint8Array;
}): Promise<CompositeResult> {
  const width = CANONICAL_SIZE;
  const height = CANONICAL_SIZE;
  const pixelCount = width * height;
  validateMasks(input.allowedMask, input.blendMask, pixelCount);

  const [source, generated] = await Promise.all([
    decodeRgb(input.sourceBytes),
    decodeRgb(input.generatedBytes),
  ]);
  if (
    source.width !== width ||
    source.height !== height ||
    generated.width !== width ||
    generated.height !== height
  ) {
    throw new AppError(422, "INVALID_IMAGE", "Composite inputs must both be 1024 x 1024.");
  }

  const final = Buffer.alloc(pixelCount * 3);
  let protectedPixelCount = 0;
  let rawDifference = 0;
  let finalDifference = 0;
  let protectedMismatchPixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const alpha = input.blendMask[pixel] ?? 0;
    const offset = pixel * 3;
    let pixelMismatch = false;

    for (let channel = 0; channel < 3; channel += 1) {
      const sourceChannel = source.data[offset + channel] ?? 0;
      const generatedChannel = generated.data[offset + channel] ?? 0;
      const finalChannel =
        alpha === 0
          ? sourceChannel
          : Math.round((alpha * generatedChannel + (255 - alpha) * sourceChannel) / 255);
      final[offset + channel] = finalChannel;

      if (input.allowedMask[pixel] === 0) {
        rawDifference += Math.abs(generatedChannel - sourceChannel);
        finalDifference += Math.abs(finalChannel - sourceChannel);
        if (finalChannel !== sourceChannel) pixelMismatch = true;
      }
    }

    if (input.allowedMask[pixel] === 0) {
      protectedPixelCount += 1;
      if (pixelMismatch) protectedMismatchPixels += 1;
    }
  }

  const bytes = await encodeRgbPng(final, width, height);
  return {
    bytes,
    width,
    height,
    protectedPixelCount,
    rawBackgroundMae:
      protectedPixelCount === 0 ? null : rawDifference / (3 * protectedPixelCount),
    finalBackgroundMae:
      protectedPixelCount === 0 ? null : finalDifference / (3 * protectedPixelCount),
    protectedMismatchPixels,
    compositePipelineVersion: COMPOSITE_PIPELINE_VERSION,
    maskPipelineVersion: MASK_PIPELINE_VERSION,
  };
}

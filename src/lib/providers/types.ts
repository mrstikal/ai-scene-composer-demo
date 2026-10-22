import type { Point } from "../contracts/domain";

export const IMAGE_MODELS = [
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-2.5-sunburst",
] as const;

export type ImageModel = (typeof IMAGE_MODELS)[number];

export const GENERATION_MODEL = "openai/gpt-image-2.5-flare" as const;

export interface ImageGenerationInput {
  model: typeof GENERATION_MODEL;
  prompt: string;
}

export interface ImageResponseMetadata {
  providerRequestId: string | null;
  usage: Record<string, unknown> | null;
  observedCostUsdMicros: number | null;
  latencyMs: number | null;
}

export type ImageGenerationResult =
  | ({
      kind: "image";
      bytes: Buffer;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      width: number;
      height: number;
    } & ImageResponseMetadata)
  | ({
      kind: "rejected";
      message: string;
      httpStatus: number;
    } & ImageResponseMetadata)
  | ({
      kind: "invalid";
      message: string;
      httpStatus: number;
      bytes?: Buffer;
      mimeType?: "image/png" | "image/jpeg" | "image/webp";
      width?: number;
      height?: number;
    } & ImageResponseMetadata)
  | ({
      kind: "ambiguous";
      message: string;
    } & ImageResponseMetadata);

export interface ImageGenerationAdapter {
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

export interface ImageAdapterInput {
  model: ImageModel;
  prompt: string;
  orderedInputImages: Buffer[];
}

export interface ImageAdapterResult {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  providerRequestId: string | null;
  observedCostUsdMicros: number | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
}

export interface SegmentationAdapterInput {
  image: Buffer;
  positive: Point;
  negative: Point | null;
  size?: number;
}

export interface SegmentationAdapterResult {
  fullMask: Uint8Array;
  width: number;
  height: number;
  providerRequestId: string | null;
  observedCostUsdMicros: number | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
}

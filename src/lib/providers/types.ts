import type { Point } from "../contracts/domain";

export const IMAGE_MODELS = [
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-2.5-sunburst",
] as const;

export type ImageModel = (typeof IMAGE_MODELS)[number];

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

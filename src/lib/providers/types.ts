import type { Point, SamMaskRecord } from "../contracts/domain";

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

export type ImageAdapterResult = ImageGenerationResult;

export interface ImageEditAdapter {
  edit(input: ImageAdapterInput): Promise<ImageGenerationResult>;
}

export interface SegmentationAdapterInput {
  image: Buffer;
  width: number;
  height: number;
  positivePoints: Point[];
  negativePoints: Point[];
  prompt: string;
}

export interface SegmentationResponseMetadata {
  providerRequestId: string | null;
  observedCostUsdMicros: number | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
}

export type SegmentationAdapterResult =
  | ({
      kind: "mask";
      representation: "sam-records";
      records: SamMaskRecord[];
      fullMask: Uint8Array;
      width: number;
      height: number;
    } & SegmentationResponseMetadata)
  | ({
      kind: "mask";
      representation: "full-mask";
      fullMask: Uint8Array;
      width: number;
      height: number;
    } & SegmentationResponseMetadata)
  | ({
      kind: "rejected";
      message: string;
      httpStatus: number | null;
    } & SegmentationResponseMetadata)
  | ({
      kind: "invalid";
      message: string;
      httpStatus: number | null;
    } & SegmentationResponseMetadata)
  | ({
      kind: "ambiguous";
      message: string;
      errorCode?: "PROVIDER_TIMEOUT" | "INTERRUPTED";
    } & SegmentationResponseMetadata);

export interface SegmentationAdapter {
  segment(input: SegmentationAdapterInput): Promise<SegmentationAdapterResult>;
}

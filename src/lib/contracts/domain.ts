import { z } from "zod";

export const pointSchema = z.object({
  x: z.number().int().min(0).max(1023),
  y: z.number().int().min(0).max(1023),
});

export type Point = z.infer<typeof pointSchema>;

export const sourceMetadataSchema = z.object({
  fixtureId: z.string().min(1),
  provenance: z.enum(["licensed_photo", "synthetic"]),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  normalizationVersion: z.literal("normalization-v1"),
  licenseRecord: z.string().nullable(),
  generator: z.string().optional(),
  generatorVersion: z.string().optional(),
});

export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

export const evaluationSchema = z.object({
  boundaryArtifacts: z.number().int().min(1).max(5),
  promptAdherence: z.number().int().min(1).max(5),
  referenceFidelity: z.number().int().min(1).max(5).nullable(),
  plausibility: z.number().int().min(1).max(5),
  notes: z.string().max(1000),
});

export type Evaluation = z.infer<typeof evaluationSchema>;

const responseMetadataSchema = z.record(z.string(), z.unknown());

export const providerReceiptSchema = z.union([
  z
    .object({
      kind: z.literal("image"),
      complete: z.literal(true),
      rawAssetId: z.string().uuid(),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("segment"),
      representation: z.literal("sam-records"),
      complete: z.literal(true),
      records: z.array(z.record(z.string(), z.unknown())).min(1),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("segment"),
      representation: z.literal("full-mask-asset"),
      complete: z.literal(true),
      binaryMaskAssetId: z.string().uuid(),
      responseMetadata: responseMetadataSchema,
    })
    .strict(),
]);

export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export const runInputSnapshotSchema = z.record(z.string(), z.unknown());

export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

export const regionsSchema = z.record(z.string(), z.unknown());

export type Regions = z.infer<typeof regionsSchema>;

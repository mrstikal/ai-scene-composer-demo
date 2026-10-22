import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { writeAssetBytes } from "../assets/store";
import type { ProviderReceipt } from "../contracts/domain";
import { assets, runs, type RunRow } from "../db/schema";
import type { ImageGenerationResult } from "../providers/types";
import type { RunHandlerContext } from "./worker";

export type ImageAssetKind = "raw" | "canonical" | "final";

export interface SavedImageAsset {
  id: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  createdAt: number;
}

export async function writeImageAsset(input: {
  context: RunHandlerContext;
  run: RunRow;
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}): Promise<SavedImageAsset> {
  const assetId = randomUUID();
  const written = await writeAssetBytes({
    assetDir: input.context.env.assetDir,
    projectId: input.run.projectId,
    assetId,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
  return {
    id: assetId,
    relativePath: written.relativePath,
    sha256: written.sha256,
    bytes: input.bytes.length,
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    createdAt: Date.now(),
  };
}

export function insertImageAsset(
  context: RunHandlerContext,
  run: RunRow,
  asset: SavedImageAsset,
  kind: ImageAssetKind,
): void {
  context.db
    .insert(assets)
    .values({
      id: asset.id,
      projectId: run.projectId,
      kind,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      createdAt: asset.createdAt,
    })
    .run();
}

export async function saveImageAsset(input: {
  context: RunHandlerContext;
  run: RunRow;
  kind: ImageAssetKind;
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}): Promise<SavedImageAsset> {
  const asset = await writeImageAsset(input);
  insertImageAsset(input.context, input.run, asset, input.kind);
  return asset;
}

export function saveImageReceipt(
  context: RunHandlerContext,
  run: RunRow,
  rawAssetId: string,
  result: Extract<ImageGenerationResult, { kind: "image" }>,
): Extract<ProviderReceipt, { kind: "image" }> {
  const receipt = {
    kind: "image" as const,
    complete: true as const,
    rawAssetId,
    responseMetadata: {
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      observedCostUsdMicros: result.observedCostUsdMicros,
      latencyMs: result.latencyMs,
      nativeWidth: result.width,
      nativeHeight: result.height,
      mimeType: result.mimeType,
    },
  };
  context.db
    .update(runs)
    .set({
      rawAssetId,
      providerReceiptJson: receipt,
      stage: "processing",
    })
    .where(eq(runs.id, run.id))
    .run();
  return receipt;
}

export async function saveInvalidResultRawAsset(
  context: RunHandlerContext,
  run: RunRow,
  result: Extract<ImageGenerationResult, { kind: "invalid" }>,
): Promise<SavedImageAsset | null> {
  if (result.bytes === undefined || result.mimeType === undefined) return null;
  const asset = await saveImageAsset({
    context,
    run,
    kind: "raw",
    bytes: result.bytes,
    mimeType: result.mimeType,
    width: result.width ?? 0,
    height: result.height ?? 0,
  });
  context.db
    .update(runs)
    .set({ rawAssetId: asset.id, stage: "processing" })
    .where(eq(runs.id, run.id))
    .run();
  return asset;
}

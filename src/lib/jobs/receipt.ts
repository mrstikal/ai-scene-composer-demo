import { existsSync } from "node:fs";

import { eq } from "drizzle-orm";

import { resolveAssetPath } from "../assets/store";
import type { AppDatabase } from "../db/client";
import { assets } from "../db/schema";
import { providerReceiptSchema, type ProviderReceipt } from "../contracts/domain";

export function parseProviderReceipt(value: unknown): ProviderReceipt | null {
  const parsed = providerReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assetIsReadable(db: AppDatabase, assetId: string, assetDir?: string): boolean {
  const asset = db
    .select({ relativePath: assets.relativePath })
    .from(assets)
    .where(eq(assets.id, assetId))
    .get();
  if (asset === undefined) return false;
  if (assetDir === undefined) return true;
  try {
    return existsSync(resolveAssetPath(assetDir, asset.relativePath));
  } catch {
    return false;
  }
}

export function isCompleteReceipt(
  db: AppDatabase,
  value: unknown,
  assetDir?: string,
): boolean {
  const receipt = parseProviderReceipt(value);
  if (receipt === null) return false;

  if (receipt.kind === "image") {
    return assetIsReadable(db, receipt.rawAssetId, assetDir);
  }

  if (receipt.representation === "full-mask-asset") {
    return assetIsReadable(db, receipt.binaryMaskAssetId, assetDir);
  }

  return receipt.records.length > 0;
}

import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { assets } from "../db/schema";
import { providerReceiptSchema, type ProviderReceipt } from "../contracts/domain";

export function parseProviderReceipt(value: unknown): ProviderReceipt | null {
  const parsed = providerReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isCompleteReceipt(db: AppDatabase, value: unknown): boolean {
  const receipt = parseProviderReceipt(value);
  if (receipt === null) return false;

  if (receipt.kind === "image") {
    return (
      db.select({ id: assets.id }).from(assets).where(eq(assets.id, receipt.rawAssetId)).get() !== undefined
    );
  }

  if (receipt.representation === "full-mask-asset") {
    return (
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, receipt.binaryMaskAssetId))
        .get() !== undefined
    );
  }

  return receipt.records.length > 0;
}

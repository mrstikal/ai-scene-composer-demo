import type { RetryMode, RunSummaryDto } from "../contracts/api";
import { getPricingConfig } from "../config/pricing";
import type { RunRow, UsageEventRow } from "../db/schema";
import { parseProviderReceipt } from "../jobs/receipt";

export function classifyRetryMode(run: RunRow, usage: UsageEventRow | undefined): RetryMode {
  if (run.kind !== "generate") return "none";
  if (run.status !== "failed" && run.status !== "needs_review") return "none";
  if (run.errorCode === "ROOT_ALREADY_EXISTS") return "none";

  const receipt = parseProviderReceipt(run.providerReceiptJson);
  if (
    receipt !== null &&
    (run.errorCode === "LOCAL_PROCESSING_FAILED" || run.errorCode === "PROTECTED_PIXELS_CHANGED")
  ) {
    return "local";
  }

  if (run.providerStartedAt !== null || run.errorCode === "PROVIDER_UNAVAILABLE") {
    return "provider";
  }

  if (usage?.outcome === "unknown") return "provider";
  return "none";
}

export function retryReservationUsdMicros(
  run: RunRow,
  mode: RetryMode,
  imageReservationUsdMicros = getPricingConfig().reservations.image.usdMicros,
): number {
  if (mode === "local" || mode === "none") return 0;
  if (run.executionMode === "mock") return 0;
  return imageReservationUsdMicros;
}

export function inputSummaryFor(run: RunRow): RunSummaryDto["inputSummary"] {
  const snapshot = run.inputSnapshotJson;
  if (snapshot === null || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== "preset" && mode !== "custom") return null;
  return {
    mode,
    presetId: typeof record.presetId === "string" ? record.presetId : null,
  };
}

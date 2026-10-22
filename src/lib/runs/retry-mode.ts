import type { RetryMode, RunSummaryDto } from "../contracts/api";
import { getPricingConfig } from "../config/pricing";
import { editMetricsSchema, editSnapshotSchema, segmentSnapshotSchema } from "../contracts/domain";
import type { RunRow, UsageEventRow } from "../db/schema";
import { parseProviderReceipt } from "../jobs/receipt";

export function classifyRetryMode(run: RunRow, usage: UsageEventRow | undefined): RetryMode {
  if (run.kind === "edit") {
    if (run.status !== "failed" && run.status !== "needs_review") return "none";

    const editReceipt = parseProviderReceipt(run.providerReceiptJson);
    if (
      editReceipt !== null &&
      editReceipt.kind === "image" &&
      (run.errorCode === "LOCAL_PROCESSING_FAILED" || run.errorCode === "PROTECTED_PIXELS_CHANGED")
    ) {
      return "local";
    }
    if (run.executionMode === "fixture") return "none";
    if (run.providerStartedAt !== null || run.errorCode === "PROVIDER_UNAVAILABLE") {
      return "provider";
    }
    if (usage?.outcome === "unknown") return "provider";
    return "none";
  }

  if (run.kind === "segment") {
    if (run.status !== "failed" && run.status !== "needs_review") return "none";

    const segmentReceipt = parseProviderReceipt(run.providerReceiptJson);
    if (segmentReceipt !== null && run.errorCode === "LOCAL_PROCESSING_FAILED") {
      return "local";
    }
    if (run.executionMode === "fixture") return "none";
    if (run.providerStartedAt !== null || run.errorCode === "PROVIDER_UNAVAILABLE") {
      return "provider";
    }
    if (usage?.outcome === "unknown") return "provider";
    return "none";
  }

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
  segmentationReservationUsdMicros = getPricingConfig().reservations.segmentation.usdMicros,
): number {
  if (mode === "local" || mode === "none") return 0;
  if (run.executionMode === "mock") return 0;
  return run.kind === "segment" ? segmentationReservationUsdMicros : imageReservationUsdMicros;
}

export function inputSummaryFor(run: RunRow): RunSummaryDto["inputSummary"] {
  if (run.kind !== "generate") return null;
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

export function segmentInputFor(run: RunRow): RunSummaryDto["segmentInput"] {
  if (run.kind !== "segment") return null;
  const parsed = segmentSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) return null;
  return {
    sourceVersionId: parsed.data.sourceVersionId,
    positivePoints: parsed.data.positivePoints,
    negativePoints: parsed.data.negativePoints,
  };
}

export function editInputFor(run: RunRow): RunSummaryDto["editInput"] {
  if (run.kind !== "edit") return null;
  const parsed = editSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) return null;
  return {
    parentVersionId: parsed.data.parentVersionId,
    selectionId: parsed.data.selectionId,
    paddingPx: parsed.data.paddingPx,
    targetLabel: parsed.data.targetLabel,
    instruction: parsed.data.instruction,
    referenceAssetIds: parsed.data.referenceAssetIds,
    model: parsed.data.model,
  };
}

export function editMetricsFor(run: RunRow): RunSummaryDto["metrics"] {
  if (run.kind !== "edit" || run.metricsJson === null) return null;
  const parsed = editMetricsSchema.safeParse(run.metricsJson);
  return parsed.success ? parsed.data : null;
}

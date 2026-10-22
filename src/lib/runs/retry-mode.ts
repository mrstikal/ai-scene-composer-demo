import type { RetryMode, RunSummaryDto } from "../contracts/api";
import { getPricingConfig } from "../config/pricing";
import {
  editMetricsSchema,
  editSnapshotSchema,
  evaluationSchema,
  segmentSnapshotSchema,
} from "../contracts/domain";
import type { RunRow, UsageEventRow } from "../db/schema";
import { parseProviderReceipt } from "../jobs/receipt";

export type ProviderReceiptKind = "image" | "segment" | null;

export type RunSummarySource = Pick<
  RunRow,
  | "id"
  | "projectId"
  | "kind"
  | "executionMode"
  | "comparisonGroupId"
  | "retryOfRunId"
  | "parentVersionId"
  | "inputSelectionId"
  | "model"
  | "inputSnapshotJson"
  | "commonInputHash"
  | "status"
  | "stage"
  | "reservedUsdMicros"
  | "budgetChargeUsdMicros"
  | "rawAssetId"
  | "normalizedRawAssetId"
  | "outputSelectionId"
  | "outputVersionId"
  | "metricsJson"
  | "evaluationJson"
  | "createdAt"
  | "startedAt"
  | "providerStartedAt"
  | "providerFinishedAt"
  | "finishedAt"
  | "errorCode"
  | "errorMessage"
> & {
  providerReceiptKind?: ProviderReceiptKind;
  providerReceiptJson?: unknown;
};

export type UsageSummarySource = Pick<
  UsageEventRow,
  "runId" | "outcome" | "amountUsdMicros" | "costProvenance" | "elapsedMs" | "settledAt"
>;

function receiptKind(run: RunSummarySource): ProviderReceiptKind {
  if (run.providerReceiptKind !== undefined) return run.providerReceiptKind;
  return parseProviderReceipt(run.providerReceiptJson)?.kind ?? null;
}

export function classifyRetryMode(
  run: RunSummarySource,
  usage: UsageSummarySource | undefined,
): RetryMode {
  if (run.kind === "edit") {
    if (run.status !== "failed" && run.status !== "needs_review") return "none";

    if (
      receiptKind(run) === "image" &&
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

    if (receiptKind(run) === "segment" && run.errorCode === "LOCAL_PROCESSING_FAILED") {
      return "local";
    }
    if (run.executionMode === "fixture" && run.errorCode !== "PROVIDER_UNAVAILABLE") {
      return "none";
    }
    if (run.providerStartedAt !== null || run.errorCode === "PROVIDER_UNAVAILABLE") {
      return "provider";
    }
    if (usage?.outcome === "unknown") return "provider";
    return "none";
  }

  if (run.kind !== "generate") return "none";
  if (run.status !== "failed" && run.status !== "needs_review") return "none";
  if (run.errorCode === "ROOT_ALREADY_EXISTS") return "none";

  if (
    receiptKind(run) === "image" &&
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
  run: RunSummarySource,
  mode: RetryMode,
  imageReservationUsdMicros = getPricingConfig().reservations.image.usdMicros,
  segmentationReservationUsdMicros = getPricingConfig().reservations.segmentation.usdMicros,
  currentExecutionMode: RunRow["executionMode"] | undefined = undefined,
): number {
  if (mode === "local" || mode === "none") return 0;
  const executionMode = currentExecutionMode ?? run.executionMode;
  if (executionMode === "mock" || executionMode === "fixture") return 0;
  return run.kind === "segment" ? segmentationReservationUsdMicros : imageReservationUsdMicros;
}

export function hasPossibleDuplicateCharge(
  run: RunSummarySource,
  usage: UsageSummarySource | undefined,
): boolean {
  if (run.providerStartedAt !== null) {
    return usage === undefined || usage.outcome === "unknown" || usage.amountUsdMicros === null;
  }
  return usage !== undefined && (usage.outcome === "unknown" || usage.outcome === "pending");
}

export function inputSummaryFor(run: RunSummarySource): RunSummaryDto["inputSummary"] {
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

export function segmentInputFor(run: RunSummarySource): RunSummaryDto["segmentInput"] {
  if (run.kind !== "segment") return null;
  const parsed = segmentSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) return null;
  return {
    sourceVersionId: parsed.data.sourceVersionId,
    positivePoints: parsed.data.positivePoints,
    negativePoints: parsed.data.negativePoints,
  };
}

export function editInputFor(run: RunSummarySource): RunSummaryDto["editInput"] {
  if (run.kind !== "edit") return null;
  const parsed = editSnapshotSchema.safeParse(run.inputSnapshotJson);
  if (!parsed.success) return null;
  return {
    scope: parsed.data.scope,
    parentVersionId: parsed.data.parentVersionId,
    selectionId: parsed.data.selectionId ?? null,
    paddingPx: parsed.data.paddingPx ?? null,
    targetLabel: parsed.data.targetLabel ?? null,
    instruction: parsed.data.instruction,
    referenceAssetIds: parsed.data.referenceAssetIds,
    model: parsed.data.model,
  };
}

export function editMetricsFor(run: RunSummarySource): RunSummaryDto["metrics"] {
  if (run.kind !== "edit" || run.metricsJson === null) return null;
  const parsed = editMetricsSchema.safeParse(run.metricsJson);
  return parsed.success ? parsed.data : null;
}

export function evaluationFor(run: RunSummarySource): RunSummaryDto["evaluation"] {
  if (run.evaluationJson === null) return null;
  const parsed = evaluationSchema.safeParse(run.evaluationJson);
  return parsed.success ? parsed.data : null;
}

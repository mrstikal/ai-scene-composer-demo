import type { RunRow } from "../db/schema";
import type {
  ImageGenerationResult,
  SegmentationAdapterResult,
} from "../providers/types";
import { markUsageUnknown } from "../usage/service";
import { settleRunAttempt } from "./settlement";
import type { RunHandlerContext } from "./worker";

export function settleImageResult(
  context: RunHandlerContext,
  run: RunRow,
  reservationUsdMicros: number,
  result: ImageGenerationResult,
): number | null {
  if (result.kind === "ambiguous") {
    markUsageUnknown(context.db, run.id);
    return null;
  }

  const observed = result.observedCostUsdMicros;
  const mock = run.executionMode === "mock";

  if (result.kind === "rejected") {
    const amount = observed ?? 0;
    settleRunAttempt(context, run.id, {
      outcome: "rejected",
      amountUsdMicros: amount,
      costProvenance: mock ? "calculated" : observed === null ? "calculated" : "provider",
      chargeUsdMicros: amount,
      usageJson: result.usage,
      providerRequestId: result.providerRequestId,
      elapsedMs: result.latencyMs,
    });
    return amount;
  }

  const amount = mock ? 0 : observed ?? reservationUsdMicros;
  settleRunAttempt(context, run.id, {
    outcome: "completed",
    amountUsdMicros: amount,
    costProvenance: mock ? "calculated" : observed !== null ? "provider" : "estimated",
    chargeUsdMicros: amount,
    usageJson: result.usage,
    providerRequestId: result.providerRequestId,
    elapsedMs: result.latencyMs,
  });
  return amount;
}

export function settleSegmentResult(
  context: RunHandlerContext,
  run: RunRow,
  calculatedCostUsdMicros: number,
  result: SegmentationAdapterResult,
): number | null {
  if (result.kind === "ambiguous") {
    markUsageUnknown(context.db, run.id);
    return null;
  }

  const live = run.executionMode === "live";
  const observed = result.observedCostUsdMicros;

  if (result.kind === "rejected") {
    const amount = live ? observed : 0;
    const provenance = live ? (observed === null ? "unavailable" : "provider") : "calculated";
    settleRunAttempt(context, run.id, {
      outcome: "rejected",
      amountUsdMicros: amount,
      costProvenance: provenance,
      chargeUsdMicros: amount,
      usageJson: result.usage,
      providerRequestId: result.providerRequestId,
      elapsedMs: result.latencyMs,
    });
    return amount;
  }

  const amount = live ? observed ?? calculatedCostUsdMicros : 0;
  const provenance = live ? (observed === null ? "calculated" : "provider") : "calculated";
  settleRunAttempt(context, run.id, {
    outcome: "completed",
    amountUsdMicros: amount,
    costProvenance: provenance,
    chargeUsdMicros: amount,
    usageJson: result.usage,
    providerRequestId: result.providerRequestId,
    elapsedMs: result.latencyMs,
  });
  return amount;
}

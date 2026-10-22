import type { RunDetailDto } from "../contracts/api";
import type { AppEnv } from "../config/env";
import { editSnapshotSchema, generationSnapshotSchema, segmentSnapshotSchema } from "../contracts/domain";
import type { AppDatabase } from "../db/client";
import { getUsageEventByRunId } from "../usage/service";
import { toRunSummary } from "../projects/service";
import { getRunOrThrow } from "./retry";

export function getRunDetail(
  db: AppDatabase,
  runId: string,
  env?: Pick<AppEnv, "imageReservationUsdMicros" | "aiMode" | "samMode">,
): RunDetailDto {
  const run = getRunOrThrow(db, runId);
  const usage = getUsageEventByRunId(db, runId);
  const segmentationReservationUsdMicros =
    env === undefined || (env.aiMode === "live" && env.samMode === "live") ? undefined : 0;
  const currentExecutionMode =
    env === undefined
      ? undefined
      : run.kind === "segment"
        ? env.aiMode === "mock"
          ? "mock"
          : env.samMode
        : env.aiMode;
  const summary = toRunSummary(
    run,
    usage,
    env?.imageReservationUsdMicros,
    segmentationReservationUsdMicros,
    currentExecutionMode,
  );

  let input: RunDetailDto["input"] = null;
  if (run.kind === "generate") {
    const parsed = generationSnapshotSchema.safeParse(run.inputSnapshotJson);
    if (parsed.success) {
      input = {
        kind: "generate",
        mode: parsed.data.mode,
        presetId: parsed.data.presetId,
        presetVersion: parsed.data.presetVersion,
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        pricingVersion: parsed.data.pricingVersion,
        capabilityVersion: parsed.data.capabilityVersion,
        reservationUsdMicros: parsed.data.reservationUsdMicros,
      };
    }
  } else if (run.kind === "segment") {
    const parsed = segmentSnapshotSchema.safeParse(run.inputSnapshotJson);
    if (parsed.success) {
      input = {
        kind: "segment",
        sourceVersionId: parsed.data.sourceVersionId,
        sourceAssetId: parsed.data.sourceAssetId,
        sourceSha256: parsed.data.sourceSha256,
        width: parsed.data.width,
        height: parsed.data.height,
        positivePoints: parsed.data.positivePoints,
        negativePoints: parsed.data.negativePoints,
        prompt: parsed.data.prompt,
        promptVersion: parsed.data.promptVersion,
        model: parsed.data.model,
        parserVersion: parsed.data.parserVersion,
        pricingVersion: parsed.data.pricingVersion,
        capabilityVersion: parsed.data.capabilityVersion,
        reservationUsdMicros: parsed.data.reservationUsdMicros,
      };
    }
  } else if (run.kind === "edit") {
    const parsed = editSnapshotSchema.safeParse(run.inputSnapshotJson);
    if (parsed.success) {
      input = {
        kind: "edit",
        parentVersionId: parsed.data.parentVersionId,
        sourceAssetId: parsed.data.sourceAssetId,
        sourceSha256: parsed.data.sourceSha256,
        selectionId: parsed.data.selectionId,
        paddingPx: parsed.data.paddingPx,
        featherPx: parsed.data.featherPx,
        regionBoundingBox: parsed.data.regionBoundingBox,
        regionPercentages: parsed.data.regionPercentages,
        targetLabel: parsed.data.targetLabel,
        instruction: parsed.data.instruction,
        prompt: parsed.data.prompt,
        promptVersion: parsed.data.promptVersion,
        model: parsed.data.model,
        referenceAssetIds: parsed.data.referenceAssetIds,
        referenceSha256: parsed.data.referenceSha256,
        maskPipelineVersion: parsed.data.maskPipelineVersion,
        normalizationVersion: parsed.data.normalizationVersion,
        transportOptions: parsed.data.transportOptions,
        pricingVersion: parsed.data.pricingVersion,
        capabilityVersion: parsed.data.capabilityVersion,
        reservationUsdMicros: parsed.data.reservationUsdMicros,
      };
    }
  }

  return {
    run: summary,
    input,
    usage:
      usage === undefined
        ? null
        : {
            outcome: usage.outcome,
            amountUsdMicros: usage.amountUsdMicros,
            costProvenance: usage.costProvenance,
            pricingVersion: usage.pricingVersion,
            providerRequestId: usage.providerRequestId,
            elapsedMs: usage.elapsedMs,
          },
  };
}

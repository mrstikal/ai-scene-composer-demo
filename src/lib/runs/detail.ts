import type { RunDetailDto } from "../contracts/api";
import type { AppEnv } from "../config/env";
import { generationSnapshotSchema } from "../contracts/domain";
import type { AppDatabase } from "../db/client";
import { getUsageEventByRunId } from "../usage/service";
import { toRunSummary } from "../projects/service";
import { getRunOrThrow } from "./retry";

export function getRunDetail(
  db: AppDatabase,
  runId: string,
  env?: Pick<AppEnv, "imageReservationUsdMicros">,
): RunDetailDto {
  const run = getRunOrThrow(db, runId);
  const usage = getUsageEventByRunId(db, runId);
  const summary = toRunSummary(run, usage, env?.imageReservationUsdMicros);

  let input: RunDetailDto["input"] = null;
  if (run.kind === "generate") {
    const parsed = generationSnapshotSchema.safeParse(run.inputSnapshotJson);
    if (parsed.success) {
      input = {
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

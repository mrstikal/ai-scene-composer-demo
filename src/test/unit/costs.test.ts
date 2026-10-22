import { describe, expect, it } from "vitest";

import { accumulateRunCost, emptyCostBuckets } from "@/lib/costs/service";
import type { RunRow, UsageEventRow } from "@/lib/db/schema";

function run(overrides: Partial<RunRow>): RunRow {
  return {
    id: "run-1",
    projectId: "project-1",
    kind: "edit",
    executionMode: "live",
    comparisonGroupId: null,
    retryOfRunId: null,
    parentVersionId: "version-1",
    inputSelectionId: "selection-1",
    model: "openai/gpt-image-2.5-flare",
    inputSnapshotJson: {},
    commonInputHash: "hash",
    status: "succeeded",
    stage: "done",
    reservedUsdMicros: 0,
    budgetChargeUsdMicros: 0,
    outputVersionId: null,
    outputSelectionId: null,
    rawAssetId: null,
    normalizedRawAssetId: null,
    providerStartedAt: null,
    providerFinishedAt: null,
    providerReceiptJson: null,
    metricsJson: null,
    evaluationJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageEventRow>): UsageEventRow {
  return {
    id: "usage-1",
    projectId: "project-1",
    runId: "run-1",
    operation: "edit",
    provider: "openrouter",
    model: "openai/gpt-image-2.5-flare",
    executionMode: "live",
    pricingVersion: "2026-10-21-v1",
    pricingSourceSnapshotJson: {},
    providerRequestId: null,
    usageJson: null,
    outcome: "completed",
    amountUsdMicros: null,
    costProvenance: "calculated",
    elapsedMs: null,
    createdAt: 1,
    settledAt: 2,
    ...overrides,
  };
}

describe("cost bucket partition", () => {
  it("assigns each run to exactly one provenance, reservation or hold bucket", () => {
    const buckets = emptyCostBuckets();

    accumulateRunCost(
      buckets,
      run({ id: "provider", budgetChargeUsdMicros: 120 }),
      usage({ runId: "provider", amountUsdMicros: 120, costProvenance: "provider" }),
    );
    accumulateRunCost(
      buckets,
      run({ id: "calculated", budgetChargeUsdMicros: 0 }),
      usage({ runId: "calculated", amountUsdMicros: 0, costProvenance: "calculated" }),
    );
    accumulateRunCost(
      buckets,
      run({ id: "estimated", budgetChargeUsdMicros: 250000 }),
      usage({ runId: "estimated", amountUsdMicros: 250000, costProvenance: "estimated" }),
    );
    accumulateRunCost(
      buckets,
      run({ id: "unknown", status: "needs_review", budgetChargeUsdMicros: 250000 }),
      usage({
        runId: "unknown",
        outcome: "unknown",
        amountUsdMicros: null,
        costProvenance: "unavailable",
        settledAt: 2,
      }),
    );
    accumulateRunCost(
      buckets,
      run({ id: "active", status: "running", budgetChargeUsdMicros: 250000 }),
      undefined,
    );
    accumulateRunCost(
      buckets,
      run({ id: "pre-provider", status: "failed", budgetChargeUsdMicros: 0 }),
      undefined,
    );
    accumulateRunCost(
      buckets,
      run({ id: "terminal-hold", status: "failed", budgetChargeUsdMicros: 100 }),
      undefined,
    );

    expect(buckets).toEqual({
      providerUsdMicros: 120,
      calculatedUsdMicros: 0,
      estimatedUsdMicros: 250000,
      activeReservationUsdMicros: 250000,
      unknownHoldUsdMicros: 250100,
    });
  });

  it("keeps unknown amounts null rather than silently charging zero", () => {
    const buckets = emptyCostBuckets();
    accumulateRunCost(
      buckets,
      run({ budgetChargeUsdMicros: 500000 }),
      usage({ amountUsdMicros: null, costProvenance: "unavailable", outcome: "unknown" }),
    );
    expect(buckets.unknownHoldUsdMicros).toBe(500000);
    expect(buckets.calculatedUsdMicros).toBe(0);
    expect(buckets.estimatedUsdMicros).toBe(0);
  });
});

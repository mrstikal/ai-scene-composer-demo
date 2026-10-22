import { describe, expect, it } from "vitest";

import { classifyRetryMode, type RunSummarySource } from "@/lib/runs/retry-mode";

function segmentRun(overrides: Partial<RunSummarySource> = {}): RunSummarySource {
  return {
    id: "run-1",
    projectId: "project-1",
    kind: "segment",
    executionMode: "fixture",
    comparisonGroupId: null,
    retryOfRunId: null,
    parentVersionId: null,
    inputSelectionId: null,
    model: "meta/sam-3",
    inputSnapshotJson: {},
    commonInputHash: "hash",
    status: "failed",
    stage: "error",
    reservedUsdMicros: 0,
    budgetChargeUsdMicros: 0,
    rawAssetId: null,
    normalizedRawAssetId: null,
    outputSelectionId: null,
    outputVersionId: null,
    metricsJson: null,
    evaluationJson: null,
    createdAt: 0,
    startedAt: 0,
    providerStartedAt: null,
    providerFinishedAt: null,
    finishedAt: 0,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("segment retry classification", () => {
  it("allows a provider retry for a fixture run that never reached the provider", () => {
    expect(classifyRetryMode(segmentRun({ errorCode: "PROVIDER_UNAVAILABLE" }), undefined)).toBe(
      "provider",
    );
  });

  it("does not retry other failed fixture runs", () => {
    expect(classifyRetryMode(segmentRun({ errorCode: "INVALID_SELECTION" }), undefined)).toBe(
      "none",
    );
  });
});

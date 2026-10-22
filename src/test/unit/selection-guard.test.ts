import { describe, expect, it } from "vitest";

import type { RunSummaryDto, SelectionDto } from "@/lib/contracts/api";
import { samePoints, shouldApplySelection } from "@/lib/ui/selection-guard";

const points = [{ x: 420, y: 610 }];

function run(overrides: Partial<RunSummaryDto> = {}): RunSummaryDto {
  return {
    id: "run-1",
    kind: "segment",
    executionMode: "mock",
    model: "sam-3.1",
    status: "succeeded",
    stage: "done",
    parentVersionId: "version-1",
    outputVersionId: null,
    outputSelectionId: "selection-1",
    rawAssetId: null,
    normalizedRawAssetId: null,
    comparisonGroupId: null,
    retryOfRunId: null,
    commonInputHash: null,
    inputSummary: null,
    segmentInput: {
      sourceVersionId: "version-1",
      positivePoints: points,
      negativePoints: [],
    },
    editInput: null,
    metrics: null,
    evaluation: null,
    retryMode: "none",
    retryReservationUsdMicros: 0,
    providerLatencyMs: null,
    errorCode: null,
    errorMessage: null,
    cost: {
      reservedUsdMicros: 0,
      budgetChargeUsdMicros: 0,
      amountUsdMicros: 0,
      provenance: "calculated",
      outcome: "completed",
    },
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    ...overrides,
  };
}

function selection(overrides: Partial<SelectionDto> = {}): SelectionDto {
  return {
    id: "selection-1",
    sourceVersionId: "version-1",
    positivePoints: points,
    negativePoints: [],
    binaryMaskAssetId: "asset-1",
    regions: {} as SelectionDto["regions"],
    createdAt: 3,
    ...overrides,
  };
}

describe("selection stale-result guard", () => {
  it("applies a result only when the version and point fingerprint match", () => {
    const pending = {
      sourceVersionId: "version-1",
      positivePoints: points,
      negativePoints: [],
    };
    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending,
        run: run(),
        selection: selection(),
      }),
    ).toBe(true);

    expect(
      shouldApplySelection({
        activeVersionId: "version-2",
        pending,
        run: run(),
        selection: selection(),
      }),
    ).toBe(false);

    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending: { ...pending, sourceVersionId: "version-2" },
        run: run(),
        selection: selection(),
      }),
    ).toBe(false);

    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending: { ...pending, positivePoints: [{ x: 1, y: 2 }] },
        run: run(),
        selection: selection(),
      }),
    ).toBe(false);

    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending,
        run: run({ status: "failed" }),
        selection: selection(),
      }),
    ).toBe(false);

    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending,
        run: run({ parentVersionId: "version-2" }),
        selection: selection(),
      }),
    ).toBe(false);

    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending,
        run: run(),
        selection: selection({ sourceVersionId: "version-2" }),
      }),
    ).toBe(false);
  });

  it("allows the latest saved selection after reload when no request is pending", () => {
    expect(
      shouldApplySelection({
        activeVersionId: "version-1",
        pending: null,
        run: run(),
        selection: selection(),
      }),
    ).toBe(true);
  });

  it("compares point arrays exactly", () => {
    expect(samePoints(points, [{ x: 420, y: 610 }])).toBe(true);
    expect(samePoints(points, [{ x: 420, y: 611 }])).toBe(false);
    expect(samePoints(points, [])).toBe(false);
  });
});

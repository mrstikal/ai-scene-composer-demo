import { describe, expect, it } from "vitest";

import type { RunSummaryDto } from "@/lib/contracts/api";
import {
  detectRunTransitions,
  isActiveRunStatus,
  runActionLabel,
  runFailureText,
  runSuccessText,
} from "@/lib/ui/action-feed";

function run(overrides: Partial<RunSummaryDto>): RunSummaryDto {
  return {
    id: "run-1",
    kind: "edit",
    executionMode: "mock",
    model: "openai/gpt-image-2.5-flare",
    status: "queued",
    stage: "queued",
    parentVersionId: null,
    outputVersionId: null,
    outputSelectionId: null,
    rawAssetId: null,
    normalizedRawAssetId: null,
    comparisonGroupId: null,
    retryOfRunId: null,
    commonInputHash: null,
    inputSummary: null,
    segmentInput: null,
    editInput: null,
    metrics: null,
    evaluation: null,
    retryMode: "none",
    retryReservationUsdMicros: 0,
    possibleDuplicateCharge: false,
    providerLatencyMs: null,
    errorCode: null,
    errorMessage: null,
    cost: {
      reservedUsdMicros: 0,
      budgetChargeUsdMicros: 0,
      amountUsdMicros: null,
      provenance: null,
      outcome: null,
    },
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("action feed labels", () => {
  it("maps run kinds and comparison groups to action labels", () => {
    expect(
      runActionLabel({ kind: "generate", comparisonGroupId: null }),
    ).toBe("scene generation");
    expect(runActionLabel({ kind: "segment", comparisonGroupId: null })).toBe("SAM selection");
    expect(runActionLabel({ kind: "edit", comparisonGroupId: null })).toBe("scene edit");
    expect(runActionLabel({ kind: "edit", comparisonGroupId: "group-1" })).toBe(
      "model comparison",
    );
  });

  it("treats queued and running as active", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("needs_review")).toBe(false);
  });
});

describe("detectRunTransitions", () => {
  it("reports a queued run that succeeded", () => {
    const previous = new Map<string, RunSummaryDto["status"]>([["run-1", "queued"]]);
    const transitions = detectRunTransitions(
      previous,
      [run({ status: "succeeded", finishedAt: 10 })],
      0,
    );
    expect(transitions).toEqual([
      {
        runId: "run-1",
        label: "scene edit",
        outcome: "succeeded",
        message: null,
      },
    ]);
  });

  it("reports a failed running run with its error message", () => {
    const previous = new Map<string, RunSummaryDto["status"]>([["run-1", "running"]]);
    const transitions = detectRunTransitions(
      previous,
      [
        run({
          status: "failed",
          errorMessage: "Provider returned 500.",
          finishedAt: 10,
        }),
      ],
      0,
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.outcome).toBe("failed");
    expect(runFailureText(transitions[0]!)).toBe(
      "Scene edit failed: Provider returned 500.",
    );
  });

  it("reports an uncertain outcome as needs review", () => {
    const previous = new Map<string, RunSummaryDto["status"]>([["run-1", "running"]]);
    const transitions = detectRunTransitions(
      previous,
      [run({ status: "needs_review", errorMessage: "Timeout after dispatch.", finishedAt: 10 })],
      0,
    );
    expect(transitions[0]?.outcome).toBe("needs_review");
    expect(runFailureText(transitions[0]!)).toContain("needs review");
  });

  it("reports a fast run first seen as terminal after the feed started", () => {
    const transitions = detectRunTransitions(
      new Map(),
      [run({ status: "succeeded", finishedAt: 500 })],
      100,
    );
    expect(transitions).toHaveLength(1);
    expect(runSuccessText(transitions[0]!)).toBe("Scene edit completed.");
  });

  it("ignores historical terminal runs and queued-to-running progress", () => {
    expect(
      detectRunTransitions(new Map(), [run({ status: "succeeded", finishedAt: 50 })], 100),
    ).toEqual([]);

    const previous = new Map<string, RunSummaryDto["status"]>([["run-1", "queued"]]);
    expect(
      detectRunTransitions(previous, [run({ status: "running", finishedAt: null })], 0),
    ).toEqual([]);
  });

  it("stays silent for terminal runs that were already active before", () => {
    const previous = new Map<string, RunSummaryDto["status"]>([["run-1", "failed"]]);
    expect(
      detectRunTransitions(previous, [run({ status: "failed", finishedAt: 10 })], 0),
    ).toEqual([]);
  });
});
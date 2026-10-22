import type { RunSummaryDto } from "@/lib/contracts/api";

export type RunStatus = RunSummaryDto["status"];

export function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export function runActionLabel(
  run: Pick<RunSummaryDto, "kind" | "comparisonGroupId">,
): string {
  if (run.kind === "generate") return "scene generation";
  if (run.kind === "segment") return "SAM selection";
  return run.comparisonGroupId === null ? "scene edit" : "model comparison";
}

export interface RunTransition {
  runId: string;
  label: string;
  outcome: "succeeded" | "failed" | "needs_review";
  message: string | null;
}

export function detectRunTransitions(
  previous: ReadonlyMap<string, RunStatus>,
  runs: readonly RunSummaryDto[],
  recentSince: number,
): RunTransition[] {
  const transitions: RunTransition[] = [];
  for (const run of runs) {
    const before = previous.get(run.id);
    const nowActive = isActiveRunStatus(run.status);
    const becameTerminal = before !== undefined && isActiveRunStatus(before) && !nowActive;
    const appearedTerminal =
      before === undefined &&
      !nowActive &&
      run.finishedAt !== null &&
      run.finishedAt >= recentSince;

    if (!becameTerminal && !appearedTerminal) continue;
    if (run.status === "succeeded") {
      transitions.push({
        runId: run.id,
        label: runActionLabel(run),
        outcome: "succeeded",
        message: run.errorMessage,
      });
    } else if (run.status === "failed" || run.status === "needs_review") {
      transitions.push({
        runId: run.id,
        label: runActionLabel(run),
        outcome: run.status,
        message: run.errorMessage,
      });
    }
  }
  return transitions;
}

export function runFailureText(transition: RunTransition): string {
  const label = transition.label.charAt(0).toUpperCase() + transition.label.slice(1);
  if (transition.outcome === "needs_review") {
    return `${label} needs review. ${transition.message ?? "The outcome is uncertain."}`;
  }
  return `${label} failed: ${transition.message ?? "Unknown error."}`;
}

export function runSuccessText(transition: RunTransition): string {
  const label = transition.label.charAt(0).toUpperCase() + transition.label.slice(1);
  return `${label} completed.`;
}
"use client";

import { useMemo } from "react";

import type { ProjectSnapshotDto } from "@/lib/contracts/api";
import type { MaskPaddingPx, Point } from "@/lib/contracts/domain";
import {
  shouldApplySelection,
  type PendingSelectionRequest,
} from "@/lib/ui/selection-guard";

export function versionProvenance(version: ProjectSnapshotDto["versions"][number]): string | null {
  const metadata = version.sourceMetadata as { provenance?: unknown } | null;
  if (metadata?.provenance === "synthetic") return "Synthetic Sample";
  if (metadata?.provenance === "licensed_photo") return "Licensed photo";
  return null;
}

export interface SelectionStateInput {
  snapshot: ProjectSnapshotDto | null;
  projectId: string | null;
  selectionMode: "positive" | "negative";
  positivePoints: Point[];
  negativePoints: Point[];
  selectedSelectionId: string | null;
  selectionUiVersionId: string | null;
  pendingSelection: (PendingSelectionRequest & { runId: string }) | null;
  selectionSubmitting: { projectId: string; sourceVersionId: string } | null;
  selectionAttemptFailed: boolean;
  paddingPx: MaskPaddingPx;
}

export function useSelectionState(input: SelectionStateInput) {
  const {
    snapshot,
    projectId,
    selectionMode,
    positivePoints,
    negativePoints,
    selectedSelectionId,
    selectionUiVersionId,
    pendingSelection,
    selectionSubmitting,
    selectionAttemptFailed,
    paddingPx,
  } = input;

  return useMemo(() => {
    const activeVersion =
      snapshot?.versions.find((version) => version.id === snapshot.project.activeVersionId) ?? null;
    const activeVersionId = activeVersion?.id ?? null;
    const activeProvenance = activeVersion === null ? null : versionProvenance(activeVersion);

    const selectionStateMatches = selectionUiVersionId === activeVersionId;
    const effectiveSelectionMode = selectionStateMatches ? selectionMode : "positive";
    const effectivePositivePoints = selectionStateMatches ? positivePoints : [];
    const effectiveNegativePoints = selectionStateMatches ? negativePoints : [];

    const selectionsForActive =
      activeVersionId === null
        ? []
        : snapshot?.selections.filter(
            (selection) => selection.sourceVersionId === activeVersionId,
          ) ?? [];
    const latestSelection = selectionsForActive.at(-1) ?? null;

    const segmentRunsForActive =
      activeVersionId === null
        ? []
        : snapshot?.runs.filter(
            (run) => run.kind === "segment" && run.parentVersionId === activeVersionId,
          ) ?? [];
    const pendingSegmentRun =
      segmentRunsForActive
        .filter((run) => run.status === "queued" || run.status === "running")
        .at(-1) ?? null;
    const latestSegmentRun = segmentRunsForActive.at(-1) ?? null;

    const pendingRunForRequest =
      pendingSelection === null
        ? null
        : snapshot?.runs.find((run) => run.id === pendingSelection.runId) ?? null;
    const pendingRunTerminal =
      pendingRunForRequest !== null &&
      pendingRunForRequest.status !== "queued" &&
      pendingRunForRequest.status !== "running";
    const pendingSelectionResult =
      pendingRunForRequest === null || pendingRunForRequest.outputSelectionId === null
        ? null
        : snapshot?.selections.find(
            (selection) => selection.id === pendingRunForRequest.outputSelectionId,
          ) ?? null;
    const pendingGuardPasses =
      pendingRunTerminal &&
      pendingSelection !== null &&
      pendingRunForRequest !== null &&
      shouldApplySelection({
        activeVersionId,
        pending: pendingSelection,
        run: pendingRunForRequest,
        selection: pendingSelectionResult,
      });
    const pendingGuardFailedForActiveVersion =
      pendingRunTerminal &&
      pendingSelection !== null &&
      pendingSelection.sourceVersionId === activeVersionId &&
      !pendingGuardPasses;

    const effectiveSelectedSelectionId = pendingGuardPasses
      ? pendingRunForRequest?.outputSelectionId ?? null
      : selectionStateMatches
        ? selectedSelectionId
        : null;
    const selectedSelection =
      effectiveSelectedSelectionId === null
        ? null
        : selectionsForActive.find(
            (selection) => selection.id === effectiveSelectedSelectionId,
          ) ?? null;
    const activeSelection =
      pendingGuardFailedForActiveVersion || selectionAttemptFailed
        ? null
        : selectedSelection ?? latestSelection;

    const submittingThisView =
      selectionSubmitting !== null &&
      selectionSubmitting.projectId === projectId &&
      selectionSubmitting.sourceVersionId === activeVersionId &&
      !pendingRunTerminal;
    const selectionPending = submittingThisView || pendingSegmentRun !== null;
    const displaySelection = selectionPending ? null : activeSelection;
    const draftActive = effectivePositivePoints.length > 0 || effectiveNegativePoints.length > 0;
    const displayPositivePoints = draftActive
      ? effectivePositivePoints
      : displaySelection?.positivePoints ?? [];
    const displayNegativePoints = draftActive
      ? effectiveNegativePoints
      : displaySelection?.negativePoints ?? [];
    const activeVariant =
      displaySelection === null
        ? null
        : displaySelection.regions.variants[String(paddingPx) as "16" | "32"];

    return {
      activeVersion,
      activeVersionId,
      activeProvenance,
      effectiveSelectionMode,
      effectivePositivePoints,
      effectiveNegativePoints,
      selectionsForActive,
      latestSelection,
      segmentRunsForActive,
      pendingSegmentRun,
      latestSegmentRun,
      pendingRunForRequest,
      pendingRunTerminal,
      pendingSelectionResult,
      pendingGuardPasses,
      pendingGuardFailedForActiveVersion,
      effectiveSelectedSelectionId,
      selectedSelection,
      activeSelection,
      submittingThisView,
      selectionPending,
      displaySelection,
      displayPositivePoints,
      displayNegativePoints,
      activeVariant,
    };
  }, [
    snapshot,
    projectId,
    selectionMode,
    positivePoints,
    negativePoints,
    selectedSelectionId,
    selectionUiVersionId,
    pendingSelection,
    selectionSubmitting,
    selectionAttemptFailed,
    paddingPx,
  ]);
}

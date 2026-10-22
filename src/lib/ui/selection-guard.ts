import type { RunSummaryDto, SelectionDto } from "../contracts/api";
import type { Point } from "../contracts/domain";

export interface PendingSelectionRequest {
  sourceVersionId: string;
  positivePoints: Point[];
  negativePoints: Point[];
}

export function samePoints(left: readonly Point[], right: readonly Point[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((point, index) => point.x === right[index]?.x && point.y === right[index]?.y);
}

export function shouldApplySelection(input: {
  activeVersionId: string | null;
  pending: PendingSelectionRequest | null;
  run: RunSummaryDto;
  selection: SelectionDto | null;
}): boolean {
  const { activeVersionId, pending, run, selection } = input;
  if (activeVersionId === null || selection === null) return false;
  if (run.status !== "succeeded" || run.outputSelectionId !== selection.id) return false;
  if (run.parentVersionId !== activeVersionId) return false;
  if (selection.sourceVersionId !== activeVersionId) return false;
  if (pending === null) return true;

  if (pending.sourceVersionId !== activeVersionId) return false;
  if (run.segmentInput === null) return false;
  return (
    samePoints(run.segmentInput.positivePoints, pending.positivePoints) &&
    samePoints(run.segmentInput.negativePoints, pending.negativePoints)
  );
}

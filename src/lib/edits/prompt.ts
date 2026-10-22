import {
  EDIT_PROMPT_VERSION,
  type RegionPercentages,
} from "../contracts/domain";
import { AppError } from "../errors";

export const EDIT_PROMPT_TEMPLATE_VERSION = EDIT_PROMPT_VERSION;

export function formatPercent(value: number): string {
  return value.toFixed(1);
}

export function editReferenceLine(count: number): string {
  if (count === 0) return "No additional reference images were supplied.";
  if (count === 1) {
    return "Image 2 is the user-supplied appearance reference for the target object, not a replacement scene.";
  }
  if (count === 2) {
    return "Images 2 and 3 are ordered user-supplied appearance references for the target object, not replacement scenes.";
  }
  throw new AppError(400, "INVALID_REQUEST", "Edits support zero, one or two references.");
}

export function buildEditPrompt(input: {
  targetLabel: string;
  instruction: string;
  percentages: RegionPercentages;
  referenceCount: number;
}): string {
  return [
    "Image 1 is the source scene to edit. Return one complete square scene aligned to Image 1, with the same camera, framing, geometry and lighting.",
    `Target object: ${input.targetLabel}.`,
    `Target bounding box in percent of Image 1: left=${formatPercent(input.percentages.left)}, top=${formatPercent(input.percentages.top)}, right=${formatPercent(input.percentages.right)}, bottom=${formatPercent(input.percentages.bottom)}.`,
    "Change the target object according to the instruction below. Preserve the rest of the scene. The bounding box is spatial guidance, not a native image mask.",
    "User instruction:",
    input.instruction,
    editReferenceLine(input.referenceCount),
    "",
  ].join("\n");
}

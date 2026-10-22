import type { HandlerRegistry } from "../worker";
import { createEditHandler } from "./edit";
import { createGenerateHandler } from "./generate";
import { createSegmentHandler } from "./segment";

export function createProductionHandlers(): HandlerRegistry {
  return {
    generate: createGenerateHandler(),
    segment: createSegmentHandler(),
    edit: createEditHandler(),
  };
}

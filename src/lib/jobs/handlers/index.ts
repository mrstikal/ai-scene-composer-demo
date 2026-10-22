import type { HandlerRegistry } from "../worker";
import { createGenerateHandler } from "./generate";

export function createProductionHandlers(): HandlerRegistry {
  return {
    generate: createGenerateHandler(),
  };
}

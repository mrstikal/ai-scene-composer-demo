export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatUsd(micros: number | null): string {
  if (micros === null) return "unavailable";
  return `USD ${(micros / 1_000_000).toFixed(6)}`;
}

export function modelLabel(model: string): string {
  if (model === "openai/gpt-image-2.5-flare") return "Flare";
  if (model === "openai/gpt-image-2.5-sunburst") return "Sunburst";
  return model;
}

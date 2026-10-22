import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface EvaluationCase {
  id: string;
  label: string;
  targetLabel: string;
  instruction: string;
  referenceCount: number;
}

interface EvaluationCasesFile {
  schemaVersion: number;
  sourceSampleId: string;
  notes: string[];
  cases: EvaluationCase[];
}

async function loadCases(): Promise<EvaluationCasesFile> {
  const raw = await readFile(
    join(process.cwd(), "src/test/fixtures/evaluation/cases.json"),
    "utf8",
  );
  return JSON.parse(raw) as EvaluationCasesFile;
}

describe("five fixed evaluation cases", () => {
  it("defines exactly the five required manual cases", async () => {
    const file = await loadCases();
    expect(file.schemaVersion).toBe(1);
    expect(file.sourceSampleId).toBe("living-room-v1");
    expect(file.cases.map((entry) => entry.id)).toEqual([
      "recolor-sofa",
      "replace-lamp-from-reference",
      "remove-wall-picture",
      "change-object-material",
      "change-chair",
    ]);
    expect(new Set(file.cases.map((entry) => entry.id)).size).toBe(5);
    expect(file.cases.map((entry) => entry.label)).toEqual([
      "Recolor sofa",
      "Replace lamp from a reference",
      "Remove wall picture",
      "Change object material",
      "Change chair",
    ]);
  });

  it("keeps every case complete and reference use explicit", async () => {
    const file = await loadCases();
    for (const entry of file.cases) {
      expect(entry.targetLabel.trim().length).toBeGreaterThan(0);
      expect(entry.instruction.trim().length).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(entry.referenceCount);
    }
    expect(file.cases.filter((entry) => entry.referenceCount > 0)).toHaveLength(1);
  });
});

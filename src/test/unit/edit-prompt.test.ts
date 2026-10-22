import { describe, expect, it } from "vitest";

import {
  editSnapshotSchema,
  type EditSnapshot,
} from "@/lib/contracts/domain";
import { buildEditCommonInputHash } from "@/lib/edits/common-input";
import {
  buildEditPrompt,
  buildSceneEditPrompt,
  editReferenceLine,
  formatPercent,
} from "@/lib/edits/prompt";

const percentages = { left: 33.2, top: 51.8, right: 48.9, bottom: 67.5 };

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function hex(character: string): string {
  return character.repeat(64);
}

function snapshot(overrides: Partial<EditSnapshot> = {}): EditSnapshot {
  return editSnapshotSchema.parse({
    operation: "edit",
    parentVersionId: uuid(1),
    sourceAssetId: uuid(2),
    sourceSha256: hex("a"),
    sourceWidth: 1024,
    sourceHeight: 1024,
    selectionId: uuid(3),
    selectionSourceVersionId: uuid(1),
    binaryMaskAssetId: uuid(4),
    binaryMaskSha256: hex("b"),
    paddingPx: 16,
    featherPx: 8,
    allowedMaskAssetId: uuid(5),
    allowedMaskSha256: hex("c"),
    blendMaskAssetId: uuid(6),
    blendMaskSha256: hex("d"),
    regionBoundingBox: { left: 340, top: 530, right: 501, bottom: 691 },
    regionPercentages: percentages,
    targetLabel: "sofa",
    instruction: "Make the sofa green.",
    prompt: "A frozen prompt.",
    promptSha256: hex("e"),
    promptVersion: "edit-prompt-v1",
    model: "openai/gpt-image-2.5-flare",
    referenceAssetIds: [uuid(7), uuid(8)],
    referenceSha256: [hex("f"), hex("9")],
    executionMode: "mock",
    normalizationVersion: "normalization-v1",
    maskPipelineVersion: "mask-pipeline-v1",
    pricingVersion: "2026-10-21-v1",
    capabilityVersion: "provider-capabilities-2026-10-21",
    reservationUsdMicros: 0,
    transportOptions: {
      aspectRatio: "1:1",
      quality: "medium",
      background: "opaque",
      n: 1,
      provider: { only: ["openai"], allowFallbacks: false },
      timeoutMs: 300000,
    },
    ...overrides,
  });
}

describe("edit prompt template", () => {
  it("renders the exact zero-reference prompt and one-decimal percentages", () => {
    expect(
      buildEditPrompt({
        targetLabel: "sofa",
        instruction: "Make the sofa green.",
        percentages,
        referenceCount: 0,
      }),
    ).toBe(
      [
        "Image 1 is the source scene to edit. Return one complete square scene aligned to Image 1, with the same camera, framing, geometry and lighting.",
        "Target object: sofa.",
        "Target bounding box in percent of Image 1: left=33.2, top=51.8, right=48.9, bottom=67.5.",
        "Change the target object according to the instruction below. Preserve the rest of the scene. The bounding box is spatial guidance, not a native image mask.",
        "User instruction:",
        "Make the sofa green.",
        "No additional reference images were supplied.",
        "",
      ].join("\n"),
    );
  });

  it("renders the whole-scene prompt without region guidance", () => {
    expect(
      buildSceneEditPrompt({
        instruction: "Change the lighting to night.",
        referenceCount: 1,
      }),
    ).toBe(
      [
        "Image 1 is the source scene to edit. Return one complete square scene aligned to Image 1, with the same camera and framing.",
        "Apply the instruction to the entire scene. This is a full-frame edit; no region is preserved automatically.",
        "User instruction:",
        "Change the lighting to night.",
        "Image 2 is a user-supplied style or appearance reference, not a replacement scene.",
        "",
      ].join("\n"),
    );
  });

  it("uses the exact one-reference and two-reference lines", () => {
    expect(editReferenceLine(1)).toBe(
      "Image 2 is the user-supplied appearance reference for the target object, not a replacement scene.",
    );
    expect(editReferenceLine(2)).toBe(
      "Images 2 and 3 are ordered user-supplied appearance references for the target object, not replacement scenes.",
    );
    expect(() => editReferenceLine(3)).toThrow("zero, one or two references");
  });

  it("formats percentages with one decimal", () => {
    expect(formatPercent(33.2)).toBe("33.2");
    expect(formatPercent(50)).toBe("50.0");
    expect(formatPercent(100)).toBe("100.0");
  });
});

describe("model-independent edit common input hash", () => {
  it("ignores model identity, pricing/capability versions, mode, reservation and timestamps", () => {
    const base = snapshot();
    const changed = snapshot({
      executionMode: "live",
      pricingVersion: "2027-01-01-v1",
      capabilityVersion: "provider-capabilities-2027-01-01",
      reservationUsdMicros: 250000,
    });
    expect(buildEditCommonInputHash(changed)).toBe(buildEditCommonInputHash(base));
  });

  it("changes when inference inputs, ordered references or region data change", () => {
    const base = snapshot();
    const instruction = snapshot({ instruction: "Make the sofa blue." });
    const order = snapshot({
      referenceAssetIds: [uuid(8), uuid(7)],
      referenceSha256: [hex("9"), hex("f")],
    });
    const region = snapshot({
      regionBoundingBox: { left: 300, top: 500, right: 520, bottom: 700 },
      regionPercentages: { left: 29.3, top: 48.8, right: 50.8, bottom: 68.4 },
    });

    expect(buildEditCommonInputHash(instruction)).not.toBe(buildEditCommonInputHash(base));
    expect(buildEditCommonInputHash(order)).not.toBe(buildEditCommonInputHash(base));
    expect(buildEditCommonInputHash(region)).not.toBe(buildEditCommonInputHash(base));
  });
});

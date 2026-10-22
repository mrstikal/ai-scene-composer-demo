import { describe, expect, it } from "vitest";

import {
  SCENE_PRESETS,
  SCENE_PRESET_VERSION,
  getScenePreset,
} from "@/config/scene-presets";
import { generationInputSchema } from "@/lib/contracts/api";
import { resolveGenerationPrompt } from "@/lib/generations/service";

const EXPECTED_PROMPTS = [
  "Photorealistic interior photograph of a cozy modern living room. A large beige fabric sofa is centered against the back wall, a separate wooden armchair is on the left, a black floor lamp is on the right, one framed picture hangs above the sofa, and a low wooden coffee table stands in the foreground. Soft daylight enters from a side window. The furniture is clearly separated and fully visible. Eye-level camera, realistic perspective and materials, square composition, no people, no text, no logos.",
  "Photorealistic interior photograph of a bright Scandinavian dining room. A light oak dining table with four separate chairs occupies the center, a simple pendant lamp hangs above it, a white sideboard stands against the back wall, and a potted plant is near a large window. Soft natural daylight, clearly separated furniture, realistic perspective and materials. Eye-level camera, square composition, no people, no text, no logos.",
  "Photorealistic interior photograph of a calm minimalist bedroom. A light gray upholstered bed is centered against the back wall, two separate wooden nightstands with bedside lamps flank the bed, one framed picture hangs above it, and a freestanding armchair is on the left near a window. Soft morning daylight, clearly separated furniture, realistic perspective and materials. Eye-level camera, square composition, no people, no text, no logos.",
];

describe("scene presets", () => {
  it("exposes exactly three stable v1 presets with exact prompts", () => {
    expect(SCENE_PRESET_VERSION).toBe("v1");
    expect(SCENE_PRESETS.map((preset) => preset.id)).toEqual([
      "cozy-living-room",
      "scandinavian-dining-room",
      "minimalist-bedroom",
    ]);
    expect(SCENE_PRESETS.map((preset) => preset.label)).toEqual([
      "Cozy Living Room",
      "Scandinavian Dining Room",
      "Minimalist Bedroom",
    ]);
    expect(SCENE_PRESETS.map((preset) => preset.prompt)).toEqual(EXPECTED_PROMPTS);
    expect(getScenePreset("unknown")).toBeUndefined();
  });

  it("resolves preset text on the server and trims custom text", () => {
    const preset = resolveGenerationPrompt({
      mode: "preset",
      presetId: "cozy-living-room",
    });
    expect(preset).toEqual({
      mode: "preset",
      presetId: "cozy-living-room",
      presetVersion: "v1",
      prompt: EXPECTED_PROMPTS[0],
    });

    const custom = resolveGenerationPrompt({
      mode: "custom",
      prompt: "  A sunlit study with a blue armchair.  ",
    });
    expect(custom).toEqual({
      mode: "custom",
      presetId: null,
      presetVersion: null,
      prompt: "A sunlit study with a blue armchair.",
    });
  });
});

describe("generation input schema", () => {
  it("accepts preset and custom XOR forms", () => {
    expect(
      generationInputSchema.parse({ mode: "preset", presetId: "minimalist-bedroom" }),
    ).toEqual({ mode: "preset", presetId: "minimalist-bedroom" });
    expect(generationInputSchema.parse({ mode: "custom", prompt: "  Study  " })).toEqual({
      mode: "custom",
      prompt: "Study",
    });
  });

  it("rejects mixed, unknown, empty, whitespace and oversized inputs", () => {
    expect(() =>
      generationInputSchema.parse({
        mode: "preset",
        presetId: "cozy-living-room",
        prompt: "ignored",
      }),
    ).toThrow();
    expect(() =>
      generationInputSchema.parse({
        mode: "custom",
        prompt: "Study",
        presetId: "cozy-living-room",
      }),
    ).toThrow();
    expect(() =>
      generationInputSchema.parse({ mode: "preset", presetId: "unknown" }),
    ).toThrow();
    expect(() => generationInputSchema.parse({ mode: "custom", prompt: "   " })).toThrow();
    expect(() => generationInputSchema.parse({ mode: "custom", prompt: "x".repeat(2001) })).toThrow();
    expect(
      generationInputSchema.parse({ mode: "custom", prompt: "x".repeat(2000) }),
    ).toMatchObject({ mode: "custom" });
  });
});

export const SCENE_PRESET_VERSION = "v1";

export const SCENE_PRESETS = [
  {
    id: "cozy-living-room",
    label: "Cozy Living Room",
    prompt:
      "Photorealistic interior photograph of a cozy modern living room. A large beige fabric sofa is centered against the back wall, a separate wooden armchair is on the left, a black floor lamp is on the right, one framed picture hangs above the sofa, and a low wooden coffee table stands in the foreground. Soft daylight enters from a side window. The furniture is clearly separated and fully visible. Eye-level camera, realistic perspective and materials, square composition, no people, no text, no logos.",
  },
  {
    id: "scandinavian-dining-room",
    label: "Scandinavian Dining Room",
    prompt:
      "Photorealistic interior photograph of a bright Scandinavian dining room. A light oak dining table with four separate chairs occupies the center, a simple pendant lamp hangs above it, a white sideboard stands against the back wall, and a potted plant is near a large window. Soft natural daylight, clearly separated furniture, realistic perspective and materials. Eye-level camera, square composition, no people, no text, no logos.",
  },
  {
    id: "minimalist-bedroom",
    label: "Minimalist Bedroom",
    prompt:
      "Photorealistic interior photograph of a calm minimalist bedroom. A light gray upholstered bed is centered against the back wall, two separate wooden nightstands with bedside lamps flank the bed, one framed picture hangs above it, and a freestanding armchair is on the left near a window. Soft morning daylight, clearly separated furniture, realistic perspective and materials. Eye-level camera, square composition, no people, no text, no logos.",
  },
] as const;

export type ScenePreset = (typeof SCENE_PRESETS)[number];
export type ScenePresetId = ScenePreset["id"];

export const SCENE_PRESET_IDS = SCENE_PRESETS.map((preset) => preset.id) as [
  ScenePresetId,
  ...ScenePresetId[],
];

export function getScenePreset(id: string): ScenePreset | undefined {
  return SCENE_PRESETS.find((preset) => preset.id === id);
}

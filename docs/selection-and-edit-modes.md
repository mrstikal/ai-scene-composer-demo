# Selection and Edit Modes

Last updated: 2026-10-22. This document records the post-DoD product and implementation changes: multi-point SAM selection, whole-scene editing/comparison, the responsive comparison layout and full-resolution image links. All verification below is offline/mock/fixture unless explicitly marked as live.

## 1. Multi-point SAM selection

### Behavior

- A plain canvas click starts a new selection: one positive point, no negative points.
- `Shift`-click adds a positive point.
- `Alt`/`Option`-click adds a negative point.
- The existing Positive/Negative point mode buttons remain for touch and one-handed use; a plain click in Negative point mode subtracts a point. Modifier keys take precedence over the active mode, and a negative click requires at least one existing positive point.
- A modifier click is a complete paid action: the UI sends the accumulated points, the worker runs SAM and a new immutable Selection is stored. It does not build a free draft and submit later.
- Positive and negative markers are numbered independently.

### Limits and validation

- Up to **8 positive** and **8 negative** points per request (`SAM_MAX_POINTS_PER_LABEL` in `src/lib/contracts/domain.ts`).
- Points must be integer pixels inside the 1024 x 1024 canonical image.
- Duplicate points are rejected (`Points must be unique.`); the same pixel cannot be both positive and negative (`Positive and negative points must differ.`).
- At least one positive point is required.
- The limit is a project usage policy, not a documented provider maximum. It is recorded in `src/config/provider-capabilities.json` and checked by `scripts/check-provider-contracts.mjs`.

### Request, prompt and persistence

- `POST /api/segmentations` accepts arrays:
  ```json
  {
    "projectId": "…",
    "sourceVersionId": "…",
    "positivePoints": [{ "x": 420, "y": 610 }, { "x": 520, "y": 610 }],
    "negativePoints": [{ "x": 470, "y": 610 }],
    "costConsent": { "pricingVersion": "…", "reservationUsdMicros": 2500, "acknowledged": true }
  }
  ```
- The SAM prompt keeps all positive points first, then all negative points, in request order, for object ID `1`: `<0f>1<|point;…|><|point;…|>-<|point;…|>`.
- `SegmentSnapshot`, the prompt, the request hash and masked validation use the full arrays.
- Captures/fixtures use the same arrays; `samCaptureSchema` now accepts 1-8 positives and 0-8 negatives. The capture filename convention still selects `positive` vs `negative` by whether negatives are present; any future capture should be named consistently with that rule.
- The mock adapter builds one bounding box around every positive point, fills it, and clears every negative point, then runs the same full-frame validation as live.

### UI

- `SceneCanvas` reports `additive` (`shiftKey`) and `subtractive` (`altKey`) with each click.
- `AppShell.handleCanvasSelect` owns the Photoshop-style semantics and client-side duplicate/max checks.
- `useSelectionState` stores and displays point arrays; saved selections and pending runs use array fingerprints.
- `SelectionPanel` renders every chip plus the action guidance and marks the mode buttons.
- Retry restores the retried snapshot's point arrays so the canvas markers match the run being retried.

### Source files

- `src/lib/contracts/domain.ts`, `src/lib/contracts/api.ts`
- `src/lib/segmentations/service.ts`
- `src/lib/providers/sam.ts`, `src/lib/providers/mocks.ts`
- `src/lib/images/mask-pipeline.ts`
- `src/lib/sam/capture.ts`, `src/lib/jobs/handlers/segment.ts`
- `src/components/editor/{SceneCanvas,SelectionPanel,use-selection-state}.tsx`, `src/components/AppShell.tsx`
- `src/test/unit/{sam,mocks,mask-pipeline}.test.ts`, `src/test/integration/segmentations.test.ts`, `src/test/e2e/selection.spec.ts`

## 2. Whole-scene editing

### Why this is possible

The provider already receives the canonical source image plus the instruction. The SAM mask is not sent to the model; it is used only by the local compositing stage to protect pixels outside the selected region. Whole-scene mode therefore reuses the same provider call and accepts the complete normalized output instead of compositing it through a mask.

### Scope contract

`POST /api/edits` and `POST /api/comparisons` accept `scope` (default `"selection"` for backward compatibility):

| Field | `scope: "selection"` | `scope: "scene"` |
|---|---|---|
| `selectionId` | required | forbidden |
| `paddingPx` | required (16 or 32) | forbidden |
| `targetLabel` | required | optional/ignored |
| `instruction` | required | required |
| references | 0-2 ordered | 0-2 ordered |
| model | required for edit, selected by comparison | same |

- Selection scope keeps the existing snapshot fields: selection/source binding, masks, region bbox/percentages, padding and feather.
- Scene scope omits all selection fields and uses `SCENE_EDIT_PROMPT_VERSION = "scene-prompt-v1"`.
- Old snapshots and metadata without `scope` parse as `"selection"`.
- `editRequestSchema`/`comparisonRequestSchema` reject a selection edit without a selection/padding and a scene edit with either field.

### Prompt

`buildSceneEditPrompt` in `src/lib/edits/prompt.ts` sends:

- Image 1 is the source scene; return one complete square scene with the same camera/framing.
- Apply the instruction to the entire scene; no region is preserved automatically.
- The original instruction.
- An exact style/appearance reference line for 0, 1 or 2 references.

References are style/appearance guidance, not a replacement scene. Unknown reference counts throw before the provider call.

### Worker and assets

- `loadSourceBytes` still verifies the source hash, dimensions and PNG type.
- Selection scope loads binary/allowed/blend masks once per attempt, normalizes, composites, validates `E=0` equality and persists raw/final diagnostics.
- Scene scope skips mask loading and compositing. The normalized 1024 output becomes the final asset; raw stays the provider output.
- Scene metrics use `scope: "scene"`, `protectedPixelCount: 0`, null raw/final MAE and zero mismatch pixels. The UI shows a no-guarantee notice instead of the selection diagnostics.
- The child Version, immutable parent, active-pointer rule, Continue behavior and retry rules are unchanged.
- `editSourceMetadataSchema` records `scope`; selection metadata keeps its selection, padding, target-label and mask-pipeline fields, scene metadata omits them.

### Comparison

- A scene comparison creates the same two sibling Runs with one group ID and one `commonInputHash`.
- The common hash includes `scope`; for scene scope, selection/region/padding fields hash as `null`.
- `inputSelectionId` is `null`; `getComparisonDetail().sharedSelectionCost` is `null` and the UI says that no SAM mask is shared or charged.
- Candidate cost, retry, attempt history and evaluation remain per Run.

### UI

- `EditPanel` exposes a **Selection / Whole scene** toggle. Scene mode hides the target label and padding header, changes the instruction label to **Scene instruction**, shows the no-protection warning and applies the same cost consent.
- Result cards show the scene scope notice and never show a protected-pixel warning.
- `RunDetailPanel` shows Scope, then only the fields that exist for that scope.
- `ComparisonPanel` labels candidates with `selection` or `whole scene`, shows the scene no-protection notice and hides the shared-SAM line for scene comparisons.
- Retry restores the snapshot scope automatically; no extra UI choice is needed.

### Source files

- `src/lib/contracts/domain.ts`, `src/lib/contracts/api.ts`
- `src/lib/edits/{service,prompt,common-input}.ts`
- `src/lib/comparisons/service.ts`, `src/lib/comparisons/read.ts`
- `src/lib/jobs/handlers/edit.ts`
- `src/lib/runs/{detail,retry-mode}.ts`
- `src/components/editor/EditPanel.tsx`, `src/components/compare/ComparisonPanel.tsx`, `src/components/runs/RunDetailPanel.tsx`, `src/components/AppShell.tsx`
- `src/app/api/{edits,comparisons}/route.ts`
- Tests: `src/test/unit/edit-prompt.test.ts`, `src/test/integration/{edits,comparisons}.test.ts`, `src/test/e2e/{editing,comparison}.spec.ts`

### Limits

- Whole-scene edits have **no pixel-preservation guarantee**; the model may change any part of the frame, including text, faces, geometry or unrelated objects.
- A scene edit still uses the same per-image reservation and budget rules. Retry and comparison costs are unchanged.
- The mode was verified only in mock mode as part of this change. Live Flare/Sunburst scene behavior has not been measured or added to `docs/live-evidence.md`.

## 3. Comparison layout and full-resolution links

- `ComparisonPanel` now renders full-width above the three-column workspace, not inside the 320 px right rail. It scrolls into view when a comparison is created or opened from history.
- Candidate cards sit side by side from `lg`; below that they stack. The Raw/Final control is compact (`Raw` plus a normalized-for-display note), and metric rows use a wrapping grid instead of `justify-between`.
- The Scene canvas has **Open scene full resolution** above the image.
- Comparison cards expose **Open final full resolution**, **Open raw full resolution** (Raw view) and **Open parent full resolution** (Before/After). They link directly to `/api/assets/<id>` in a new tab, so the browser displays the original canonical/raw asset.
- Source files: `src/components/editor/SceneCanvas.tsx`, `src/components/compare/ComparisonPanel.tsx`, `src/components/AppShell.tsx`.

## 4. Troubleshooting: "Selection was not found in this project."

If a whole-scene submit fails with **Selection was not found in this project.**, the request reached the API with `scope: "selection"` (or without `scope`) and an unknown `selectionId`. That is not produced by current code for a scene request; it indicates a stale client bundle or a stale server/worker process.

Check and fix:

1. Confirm the running API is scope-aware. This probe must return `400 ... scope: A whole-scene edit does not accept a selection or padding.` and must not create a run:
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/edits \
     -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"projectId":"<id>","parentVersionId":"<id>","scope":"scene","selectionId":"00000000-0000-4000-8000-000000000000","instruction":"probe","referenceAssetIds":[],"model":"openai/gpt-image-2.5-flare","costConsent":{"pricingVersion":"<pricing>","reservationUsdMicros":0,"acknowledged":true}}'
   ```
2. Restart `npm run worker` after code changes; it does not watch files.
3. Stop `npm run dev`, run `rm -rf .next`, start `npm run dev` again and hard-refresh the browser tab. Do not run `npm run build` while the dev server is running.
4. Re-check the run snapshot: a scene edit must have `scope: "scene"`, `selectionId: null`/absent and `input_selection_id: null`.

Verified 2026-10-22: on a copy of the live project database with mock providers, the current tree accepted a whole-scene edit (`202`) and the worker produced a child Version with `scope: "scene"` and no SAM selection.

## 5. Verification

Run on 2026-10-22 under Node 24:

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — 35 files / 208 tests pass
- `npm run build` — pass
- `npm run check:contracts` — pass
- Playwright mock suite contains 16 tests: 4 generation, 5 selection, 4 editing, 2 comparison/evaluation and 1 mobile/accessibility. The affected specs passed after these changes: 5 selection, 4 editing and 2 comparison tests, including Shift/Alt, whole-scene and action-feedback scenarios.
- Layout was additionally checked by screenshot at 1440 px and 390 px; no horizontal overflow.

Mock/fixture results are not live evidence. No paid SAM or OpenRouter calls were made for these changes.

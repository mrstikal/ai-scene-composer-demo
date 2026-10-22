# AI Scene Composer PoC

Local single-user Next.js application for scene upload/sample, version history and, in later phases, object-aware editing. The delivery contract is [AI_SCENE_COMPOSER_POC_PLAN.md](./AI_SCENE_COMPOSER_POC_PLAN.md).

Current implementation: **Phase 5 comparison, metering and evaluation**. Upload, bundled sample, project/version read-back, health, worker foundation, deterministic mock adapters, preset/custom generation, source-bound SAM selection, single-model and side-by-side editing, frozen-input comparison, project costs, manual evaluation and the five-case evaluation fixture are implemented. A paid live comparison using both models is still required for full live completion.

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- npm with the committed `package-lock.json`
- No provider credentials are required for the default mock demo.

## Setup

```bash
npm ci
cp .env.example .env.local
npm run fixtures:prepare
npm run db:migrate
```

Run the app and worker in two terminals:

```bash
npm run dev
npm run worker
```

Open `http://127.0.0.1:3000`. The worker prints `SCENE_WORKER_READY` after acquiring the single-worker lock and completing startup recovery.

## Modes

- `AI_MODE=mock` (default): deterministic test doubles, no network calls and zero provider charges.
- `AI_MODE=live`, `SAM_MODE=fixture`: real OpenRouter plus source-bound prerecorded SAM selection; no Meta key required.
- `AI_MODE=live`, `SAM_MODE=live`: real OpenRouter and Meta; both keys/accounts required.

`SAM_MODE` has no effect in mock mode. Missing live credentials disable only the affected function; they do not enable mock fallback automatically.

## Fixture slots

`npm run fixtures:prepare` always generates both deterministic 1024 x 1024 synthetic PNGs from project-authored SVG primitives:

- `src/test/fixtures/synthetic/living-room-v1.png`
- `src/test/fixtures/synthetic/reference-sofa-v1.png`

Optional owner-supplied photographs replace them only when the required permission record exists:

| Slot | Photograph | Permission record |
|---|---|---|
| `living-room-v1` | `src/test/fixtures/photos/living-room-v1.jpg` or `.png`, square and at least 1024 x 1024 | `src/test/fixtures/licenses/living-room-v1.md` |
| `reference-sofa-v1` | `src/test/fixtures/photos/reference-sofa-v1.jpg` or `.png`, at least 1024 px on the longest side | `src/test/fixtures/licenses/reference-sofa-v1.md` |

A photo without a permission record fails with `FIXTURE_LICENSE_MISSING`; both extensions fail with `FIXTURE_AMBIGUOUS`. The manifest records provenance, original/normalized SHA-256 hashes, normalization version and nullable license record. Synthetic sources are labeled **Synthetic Sample** and never counted as satisfying the licensed-photograph gate.

`GET /api/health` reports `fixtures.licensedPhotosReady` separately from synthetic availability. Missing photographs are a deferred photo gate, not a mock-demo blocker.

## SAM captures

Live SAM is opt-in via `SAM_MODE=live` with `META_MODEL_API_KEY`. Sources are 1024 x 1024 canonical PNGs; point coordinates are integer pixels in that space.

`SAM_MODE=fixture` replays only an authentic, completed capture bound to the exact canonical source hash, normalization version, model and point arrays:

- `src/test/fixtures/sam/living-room-v1.positive.json` for a positive-only request
- `src/test/fixtures/sam/living-room-v1.negative.json` for a positive plus negative request

Captures must use `sourceKind: "captured-live"` and contain the completed SAM box/mask records. The repository does not fabricate captures; when none match, fixture mode returns `503 PROVIDER_UNAVAILABLE` before creating a Run or charge. Mock mode still exercises the full selection path without provider calls. `GET /api/health` reports `fixtures.samFixtureReady` only when both capture files validate and match the prepared sample hash.

## Commands

```bash
npm run dev              # Next.js app on 127.0.0.1
npm run worker           # single Node worker
npm run fixtures:prepare # offline synthetic/photo fixture preparation
npm run db:generate      # generate Drizzle migrations after a schema change
npm run db:migrate       # apply committed migrations
npm run check:contracts  # Phase 0 provider/config drift check
npm test                 # Vitest unit and integration tests
npm run typecheck        # strict TypeScript
npm run lint             # ESLint
npm run build            # production build
npm run test:e2e         # Playwright mock generation, SAM selection, editing and comparison
npm run test:live        # guarded opt-in live smoke (later phases)
RESET_LOCAL_DATA=1 npm run data:reset
```

`data:reset` is destructive, requires stopped web/worker processes and refuses custom storage paths outside the dedicated `data/` and `assets-local/` directories.

## Generation

The Generate tab offers exactly three server-resolved presets and a Custom Prompt option. Preset text is read-only and resolved on the server; custom text is trimmed and limited to 1-2000 characters. The form requires explicit cost consent showing the current pricing version and reservation.

`POST /api/generations` requires an `Idempotency-Key`, accepts only an empty project, and returns `202 {runId}`. The worker calls the selected adapter exactly once, persists raw/canonical assets, a durable receipt and a UsageEvent, then atomically installs the root. Mock generation returns the labeled synthetic scene with a zero calculated charge; it still exercises the real queue, receipt, root and accounting paths. A late generation that loses the root race keeps its artifacts/cost and fails with `ROOT_ALREADY_EXISTS`. Failed or ambiguous runs expose a server-derived retry mode; receipt-only local retries reuse the same Run without another provider call.

## SAM selection

`POST /api/segmentations` requires an `Idempotency-Key` and exactly one positive point, optionally one negative point. The server derives the 1024 x 1024 dimensions and source hash from the selected Version's canonical asset, validates ownership, provider availability, pricing consent and budget, and returns `202 {runId}`. A click is the intentional paid action; the UI shows the per-click reservation beside the canvas.

The worker parses the official `@meta-sam/parser` stream once, requires a completed outcome without error diagnostics, selects the box/mask records for object ID `1`, pastes the cropped raster at its half-open box origin into a full-frame mask, and rejects out-of-bounds, empty, misaligned or point-inconsistent masks. The Selection is immutable and bound to one source Version. It stores the full-frame binary mask plus two region variants:

- `padding 16` and `padding 32` square dilations of the object mask
- an 8-pixel inward feather `A` where each pixel is `round(255 * valid erode count / 8)`
- half-open bounding boxes and one-decimal percentages for prompt guidance

Padding changes reuse the saved variants and never call SAM again. The UI supports positive/negative point modes, mask visibility and opacity, allowed-region display, saved-selection reuse on the same Version, pending submission guards, and stale-result guards based on the source Version and point fingerprint.

Live completed SAM responses reserve and charge the verified per-image rate (`USD 0.0025`); mock and fixture runs record zero calculated cost. A definitive rejection with no provider cost evidence leaves the reservation as a hold, and ambiguous outcomes remain `unknown` with `needs_review`.

## Editing and branches

`POST /api/edits` requires an `Idempotency-Key`, the active parent Version, a successful Selection on that same Version, padding 16 or 32, a target label, an instruction, zero to two ordered reference assets, and a supported model. The server freezes the parent hash, Selection, chosen region, references, compiled prompt and transport options in the Run snapshot. The source image is always the first provider image; references follow in explicit order. No mask, E/A image or visual guide is sent to OpenRouter.

The worker calls the selected adapter at most once, persists raw/canonical assets and a durable receipt, then composites the normalized generated image with the stored E/A region:

- `A=0` copies the parent RGB exactly.
- `A=255` copies the generated RGB exactly.
- Intermediate alpha uses `round((A*G + (255-A)*S)/255)`.
- Every protected pixel (`E=0`) must remain byte-equal to the parent; final background MAE and mismatch count must be zero.
- Diagnostics persist protected pixel count, raw/final background MAE and mismatch count. An edit with no protected pixels succeeds but is flagged as not demonstrating pixel preservation.

A successful edit creates an immutable child Version with the final asset, raw asset reference and edit metadata. It does **not** switch the project's active Version. The UI shows raw/final output, the exact-parent before/after slider and a Continue action; only Continue or an explicit history click changes the active pointer. Reference uploads are stored as project assets, and the project read model exposes safe reference summaries for reuse after reload.

The model selector exposes exactly **Flare** and **Sunburst**. A single edit sends only the selected model; the provider contract, prompt, mask handling and compositing path are identical for both.

## Comparison

`POST /api/comparisons` accepts the edit body without a model. In one immediate transaction the server validates the shared inputs once, freezes identical model-independent snapshots for Flare and Sunburst, checks the combined two-image reservation atomically and inserts exactly two sibling Runs with one `comparisonGroupId`. Both initial Runs have the same parent Version, Selection, references, prompt, transport options and `commonInputHash`; neither run can chain from the other candidate. If the combined reservation exceeds the remaining project budget, neither Run nor an idempotency record is created.

The response is `202 {comparisonGroupId, runIds:[flareRunId, sunburstRunId]}`. Candidate order is preserved in the response and UI even when the worker claims them in a different order. `GET /api/comparisons/:id` returns grouped candidate Runs and attempts, the successful Selection's originating SAM cost exactly once, and per-model/combined candidate cost. A failed candidate does not hide the successful sibling; retry reruns only the failed candidate, keeps the group ID and common input hash, and leaves the sibling untouched. Initial creation inserts exactly two jobs; explicit retries may add attempts, all visible in the attempt history.

The UI shows candidates side by side with final images by default, raw/final toggles, exact-parent before/after, status, model, native/normalized dimensions, provider latency, cost provenance/holds, errors, single-candidate retry and Continue. Continue selects only that candidate's final Version. The comparison and its evaluation are rehydrated after reload.

## Costs and budget

`GET /api/projects/:id/costs` partitions every Run exactly once:

- settled non-null amount → its `provider`, `calculated` or `estimated` provenance bucket
- settled `unavailable` amount → `unknownHoldUsdMicros` with the retained budget charge
- queued/running unsettled attempt → `activeReservationUsdMicros`
- pre-provider failure → zero

`commitmentUsdMicros` equals the five bucket sum and the Run budget-charge sum; `remainingUsdMicros` and `overrunUsdMicros` are clamped non-negative differences against the project cap. Per-operation and per-model groups use the same partition without duplicating project limits. The event list exposes only safe request/model IDs and accounting fields, never provider JSON. The UI refreshes costs when polling reveals changed status or accounting, including settlement during local processing.

## Evaluation

`PATCH /api/runs/:id/evaluation` stores a complete manual evaluation on a successful edit Run. Scores are integers 1-5 for boundary artifacts, prompt adherence, reference fidelity and plausibility; notes are limited to 1000 characters and are not trimmed. `referenceFidelity` may be null and must be null when the edit had no references. Evaluations are mutable metadata on the Run, not on the Version or Asset. Runs without an evaluation remain unscored.

## Five-case evaluation

Definitions live in `src/test/fixtures/evaluation/cases.json`. Every executed case must use the same source Version, Selection, region, references, prompt and transport parameters for both models, and record latency, cost/provenance, normalized-raw MAE, final protected MAE/mismatch count and manual 1-5 scores. There is no aggregate ranking.

| Case | Status | Flare run | Sunburst run | Observations |
|---|---|---|---|---|
| Recolor sofa | not_run | — | — | Awaiting paid live comparison |
| Replace lamp from a reference | not_run | — | — | Awaiting paid live comparison |
| Remove wall picture | not_run | — | — | Awaiting paid live comparison |
| Change object material | not_run | — | — | Awaiting paid live comparison |
| Change chair | not_run | — | — | Awaiting paid live comparison |

The offline mock gate is fully exercisable without credentials. Full live completion still requires one paid comparison using both models on identical frozen reference-driven input.

## Storage and safety

- SQLite: `./data/scene-composer.sqlite`
- Private assets: `./assets-local/`
- Provider keys and storage paths remain server-side; they are never exposed through read DTOs or logs.
- `agent-memory/`, `.env.local`, local data, local assets and build/test artifacts are gitignored.

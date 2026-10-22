# AI Scene Composer PoC

Local single-user Next.js application for scene upload/sample, object-aware editing, version history, comparison and evaluation. The delivery contract is [AI_SCENE_COMPOSER_POC_PLAN.md](./AI_SCENE_COMPOSER_POC_PLAN.md).

Current implementation: **offline Phase 5/6 and the full live DoD are complete**. Upload, bundled sample, project/version read-back, health, worker foundation, deterministic mock adapters, preset/custom generation, source-bound SAM selection, single-model and side-by-side editing, frozen-input comparison, project costs, manual evaluation and the five-case evaluation fixture are implemented. A paid live Flare/Sunburst comparison and live SAM selection on an AI-generated scene were executed on 2026-10-22; four of the five fixed evaluation cases remain `not_run`.

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- npm with the committed `package-lock.json`
- No provider credentials are required for the default mock demo.

## Setup

```bash
nvm use                  # if nvm is installed; selects Node 24 from .nvmrc
npm ci
cp .env.example .env.local
npm run fixtures:prepare
npm run db:migrate
npx playwright install chromium
```

`npm ci` installs only the locked dependency tree; no global CLI or manual SQL is required. `fixtures:prepare` generates the synthetic PNGs, `db:migrate` applies the committed Drizzle migrations, and the Playwright browser install is only needed for browser tests. If npm 11 warns that install scripts were not run and a native module fails to load, run `npm rebuild better-sqlite3` (and `npm rebuild esbuild` if needed).

Run the app and worker in two terminals:

```bash
npm run dev
npm run worker
```

Open `http://127.0.0.1:3000`. The worker prints `SCENE_WORKER_READY` after acquiring the single-worker lock and completing startup recovery.

### Restart rules during development

The web app hot-reloads, but the worker does **not** (`tsx src/worker/index.ts` loads the code once).

- Restart `npm run worker` after any change under `src/lib/**`, `src/worker/**` or DTO/schema code. A stale worker fails new runs with confusing errors (for example an old edit handler rejecting a `scope: "scene"` snapshot) even though the UI and API already use the new code.
- Do **not** run `npm run build` while `npm run dev` is running. Both write to `.next`; the build overwrites the dev server's cache and the dev server can then serve stale or broken modules.
- If behaviour does not match the current source, stop both processes, run `rm -rf .next`, start them again and hard-refresh the browser tab (Ctrl/Cmd+Shift+R).

`npm run typecheck`, `npm run lint` and `npm test` do not need a running server.

## Modes

- `AI_MODE=mock` (default): deterministic test doubles, no network calls and zero provider charges.
- `AI_MODE=live`, `SAM_MODE=fixture`: real OpenRouter plus source-bound prerecorded SAM selection; no Meta key required.
- `AI_MODE=live`, `SAM_MODE=live`: real OpenRouter and Meta; both keys/accounts required.

`SAM_MODE` has no effect in mock mode. Missing live credentials disable only the affected function; they do not enable mock fallback automatically.

## Provider prerequisites and privacy

Live mode requires separate provider accounts and budget; mock mode requires neither.

| Provider | Used for | Required value | Data sent |
|---|---|---|---|
| OpenRouter | Generation, edit and comparison | `OPENROUTER_API_KEY` with access to Flare and Sunburst | Prompt; edit/comparison also send the source image and up to two ordered reference images |
| Meta | Live SAM selection | `META_MODEL_API_KEY` with access to hosted SAM 3.1 | Source image and positive/negative point prompts |

- Keys are read server-side from `.env.local` and are never placed in `NEXT_PUBLIC_` variables, browser configuration, read DTOs or logs. Do not commit `.env.local`.
- Live provider requests leave the local machine. Use only nonpersonal or properly licensed images, review the provider terms for retention/training behavior, and do not send sensitive material without approval.
- The app is a local single-user PoC: it binds to loopback, has no authentication and must not be exposed to a network. Private assets live under `assets-local/`, not `/public`.
- A failed or ambiguous provider call is recorded honestly; there is no automatic mock fallback and no automatic paid replay.

## Architecture constraints

- Node.js 24, Next.js App Router, React, strict TypeScript, Tailwind, SQLite/Drizzle, one local worker and private filesystem assets.
- One root Version per project; Versions, Selections and assets are immutable. A child Version is created by an explicit edit and becomes active only through Continue or a history click.
- Exactly three generation presets or one custom prompt, exactly two edit models, no extra providers, no native remote masks, no prompt-rewriting LLM and no external queue/database.
- Canonical editable images are opaque 1024 x 1024 sRGB PNGs. Raw provider output, canonical/normalized output and the final composited image remain distinct private assets.
- The worker is single-concurrency and uses a lock; provider calls happen outside SQL transactions. One Run invokes its provider at most once. Missing cost is never treated as zero.
- Read DTOs are allowlisted and exclude asset paths, provider receipts, input snapshots, raw usage and full prompts. `GET /api/runs/:id` exposes the frozen request only on demand.
- The local production path is `npm run build` + `npm run start` + `npm run worker`; serverless deployment is not supported.

## Normalization and masks

- `normalization-v1`: base scenes normalize to an opaque 1024 x 1024 sRGB PNG with `#F0F0F0` contain-padding. References preserve aspect ratio without padding or enlargement. Provider square outputs in 512-4096 normalize to 1024 with fill.
- `mask-pipeline-v1`: the SAM crop is pasted at its half-open box origin into a full-frame binary mask. Padding 16/32 is a square dilation of the object mask; the 8 px inward feather uses `round(255 * valid erode count / 8)`. Bounding boxes and one-decimal percentages are persisted for the prompt.
- `composite-v1`: `A=0` copies source RGB, `A=255` copies generated RGB, and intermediate alpha uses `round((A*G + (255-A)*S)/255)`. Every protected pixel (`E=0`) must remain byte-equal to the parent; final background MAE and mismatch count must be zero.

## Fixture slots

`npm run fixtures:prepare` always generates both deterministic 1024 x 1024 synthetic PNGs from project-authored SVG primitives:

- `src/test/fixtures/synthetic/living-room-v1.png`
- `src/test/fixtures/synthetic/reference-sofa-v1.png`

This repository supplies both optional photographs with CC0 permission records, so the committed manifest selects the photographs. Synthetic fallbacks remain available when a temporary fixture root has no photos:

| Slot | Photograph | Permission record |
|---|---|---|
| `living-room-v1` | `src/test/fixtures/photos/living-room-v1.jpg` (2048 x 2048, CC0 derivative) | `src/test/fixtures/licenses/living-room-v1.md` |
| `reference-sofa-v1` | `src/test/fixtures/photos/reference-sofa-v1.jpg` (1600 x 1061, CC0 derivative) | `src/test/fixtures/licenses/reference-sofa-v1.md` |

A photo without a permission record fails with `FIXTURE_LICENSE_MISSING`; both extensions fail with `FIXTURE_AMBIGUOUS`. The manifest records provenance, original/normalized SHA-256 hashes, normalization version and nullable license record. Synthetic sources are labeled **Synthetic Sample** and never counted as satisfying the licensed-photograph gate. The committed manifest reports `licensed_photo` for both slots.

`GET /api/health` reports `fixtures.licensedPhotosReady` separately from synthetic availability. The supplied CC0 photographs satisfy the licensed-photograph gate; the synthetic fallback remains available for isolated tests.

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
npm run test:e2e         # Playwright mock generation, SAM selection, editing, comparison and mobile/a11y
npm run test:live        # guarded live DoD; requires explicit flags and approval (see below)
RESET_LOCAL_DATA=1 npm run data:reset
```

`data:reset` is destructive, requires stopped web/worker processes and refuses custom storage paths outside the dedicated `data/` and `assets-local/` directories.

## Generation

The Generate tab offers exactly three server-resolved presets and a Custom Prompt option. Preset text is read-only and resolved on the server; custom text is trimmed and limited to 1-2000 characters. The form requires explicit cost consent showing the current pricing version and reservation.

`POST /api/generations` requires an `Idempotency-Key`, accepts only an empty project, and returns `202 {runId}`. The worker calls the selected adapter exactly once, persists raw/canonical assets, a durable receipt and a UsageEvent, then atomically installs the root. Mock generation returns the labeled synthetic scene with a zero calculated charge; it still exercises the real queue, receipt, root and accounting paths. A late generation that loses the root race keeps its artifacts/cost and fails with `ROOT_ALREADY_EXISTS`. Failed or ambiguous runs expose a server-derived retry mode; receipt-only local retries reuse the same Run without another provider call.

## SAM selection

`POST /api/segmentations` requires an `Idempotency-Key`, one to eight positive points and zero to eight negative points. The server derives the 1024 x 1024 dimensions and source hash from the selected Version's canonical asset, validates ownership, provider availability, pricing consent and budget, and returns `202 {runId}`. A click is the intentional paid action; the UI shows the per-click reservation beside the canvas. Shift-click adds a positive point and Alt/Option-click subtracts a negative point, while a plain click replaces the selection.

The worker parses the official `@meta-sam/parser` stream once, requires a completed outcome without error diagnostics, selects the box/mask records for object ID `1`, pastes the cropped raster at its half-open box origin into a full-frame mask, and rejects out-of-bounds, empty, misaligned or point-inconsistent masks. The Selection is immutable and bound to one source Version. It stores the full-frame binary mask plus two region variants:

- `padding 16` and `padding 32` square dilations of the object mask
- an 8-pixel inward feather `A` where each pixel is `round(255 * valid erode count / 8)`
- half-open bounding boxes and one-decimal percentages for prompt guidance

Padding changes reuse the saved variants and never call SAM again. The UI supports positive/negative point modes plus Photoshop-style Shift (add positive) and Alt/Option (add negative) modifiers, mask visibility and opacity, allowed-region display, saved-selection reuse on the same Version, pending submission guards, and stale-result guards based on the source Version and point fingerprint.

Live completed SAM responses reserve and charge the verified per-image rate (`USD 0.0025`); mock and fixture runs record zero calculated cost. A definitive rejection with no provider cost evidence leaves the reservation as a hold, and ambiguous outcomes remain `unknown` with `needs_review`.

## Editing and branches

`POST /api/edits` requires an `Idempotency-Key`, the active parent Version, an instruction, zero to two ordered reference assets and a supported model. `scope: "selection"` (the default) also requires a successful Selection on that same Version, padding 16 or 32 and a target label; the server freezes the Selection, chosen region and masks. `scope: "scene"` edits the whole frame and requires no Selection or padding. In both cases the server freezes the parent hash, references, compiled prompt and transport options. The source image is always the first provider image; references follow in explicit order. No mask, E/A image or visual guide is sent to OpenRouter.

The worker calls the selected adapter at most once, persists raw/canonical assets and a durable receipt, then composites the normalized generated image with the stored E/A region:

- `A=0` copies the parent RGB exactly.
- `A=255` copies the generated RGB exactly.
- Intermediate alpha uses `round((A*G + (255-A)*S)/255)`.
- Every protected pixel (`E=0`) must remain byte-equal to the parent; final background MAE and mismatch count must be zero.
- Selection edits persist protected pixel count, raw/final background MAE and mismatch count; an edit with no protected pixels succeeds but is flagged as not demonstrating pixel preservation. Whole-scene edits report `scope: "scene"`, zero protected pixels and a visible no-guarantee notice instead of the selection diagnostics.

A successful edit creates an immutable child Version with the final asset, raw asset reference and edit metadata. It does **not** switch the project's active Version. The UI shows raw/final output, the exact-parent before/after slider and a Continue action; only Continue or an explicit history click changes the active pointer. Reference uploads are stored as project assets, and the project read model exposes safe reference summaries for reuse after reload.

The model selector exposes exactly **Flare** and **Sunburst**. A single edit sends only the selected model; the provider contract and prompt are identical for both. Selection edits composite the generated image through stored masks and report protected-pixel diagnostics; whole-scene edits accept the full generated frame and report `scope: "scene"` with no protected-pixel guarantee.

## Comparison

`POST /api/comparisons` accepts the edit body without a model, including either `selection` or `scene` scope. In scene scope no SAM selection is required and `sharedSelectionCost` is null. In one immediate transaction the server validates the shared inputs once, freezes identical model-independent snapshots for Flare and Sunburst, checks the combined two-image reservation atomically and inserts exactly two sibling Runs with one `comparisonGroupId`. Both initial Runs have the same parent Version, Selection, references, prompt, transport options and `commonInputHash`; neither run can chain from the other candidate. If the combined reservation exceeds the remaining project budget, neither Run nor an idempotency record is created.

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
| Recolor sofa | passed | `1dcfadce-5525-42d5-866d-224078312d19` | `1565155d-42bc-4743-8072-fde997ff186d` | Deep green velvet sofa; boundary 4, prompt 5, plausibility 5; protected mismatch 0 |
| Replace lamp from a reference | not_run | — | — | Awaiting paid live comparison |
| Remove wall picture | not_run | — | — | Awaiting paid live comparison |
| Change object material | not_run | — | — | Awaiting paid live comparison |
| Change chair | not_run | — | — | Awaiting paid live comparison |

The offline mock gate is fully exercisable without credentials. The live DoD walkthrough also executed a reference-driven black-leather sofa comparison on a preset-generated scene; both models received identical frozen input and costs/latency were recorded. The live SAM mask selected a cushion rather than the whole sofa, so the final composite preserved most of the original; the raw/final toggle exposes the raw model change. Four fixed cases (replace lamp from a reference, remove wall picture, change object material, change chair) remain `not_run`.

## Testing

The default suite is offline and zero-cost: `AI_MODE=mock`, `SAM_MODE=fixture` and blank provider keys. Tests use fresh temporary SQLite databases and asset directories plus the committed migrations.

| Command | Coverage |
|---|---|
| `npm test` | Unit and integration tests, including provider contracts, exact mask/composite math, retries, idempotency, worker recovery, comparison atomicity, cost partitions, evaluation validation, secret/path leaks and repository hygiene |
| `npm run test:e2e` | Mock generation, multi-point SAM selection, selection/whole-scene editing, comparison/evaluation, mobile layout and basic accessibility |
| `npm run typecheck` | Strict TypeScript |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run check:contracts` | Offline provider/config drift check; no network, keys or paid probes |
| `npm run db:generate` | Should report no schema drift when migrations are current |

Current baseline after the post-DoD multi-point selection, edit-scope and action-feedback work: 35 Vitest files / 208 offline tests and 16 Playwright mock tests. Known npm audit/eslint deprecation warnings and the no-forced-upgrade policy are recorded in the fresh-install record. The detailed acceptance mapping is in [docs/test-matrix.md](docs/test-matrix.md), feature details are in [docs/selection-and-edit-modes.md](docs/selection-and-edit-modes.md) and [docs/ui-feedback.md](docs/ui-feedback.md), the fresh-install record is in [docs/setup-verification.md](docs/setup-verification.md), and live evidence is in [docs/live-evidence.md](docs/live-evidence.md); mock results never count as live evidence.

## Demo walkthrough (mock, no keys)

1. Run the setup commands above, then start `npm run dev` and `npm run worker` in two terminals and open `http://127.0.0.1:3000`.
2. Create a project with **New Scene** and choose **Use Bundled Sample**. The synthetic living-room becomes the immutable root.
3. Click the sofa on the scene canvas, then use Shift-click to add positive points and Alt/Option-click to subtract negative points; each click creates a new source-bound Selection. Switch padding 16/32 to see stored variants without another SAM call.
4. In Edit, choose **Selection** or **Whole scene**. Selection uses the target label and instruction; Whole scene sends only the instruction (for example "Change the lighting to night."). Optionally upload `src/test/fixtures/synthetic/reference-sofa-v1.png` as a reference, select **Flare** or **Sunburst**, confirm the cost, and run the edit. Inspect raw/final output, the exact-parent slider, diagnostics, the evaluation form and **Inspect Request**.
5. With the same Selection, choose **Compare Both**. Wait for both candidates, then inspect the side-by-side final images, raw/final toggle, shared SAM cost once, per-model/combined candidate cost, attempt history, request details and the optional before/after overlay. Save a manual evaluation.
6. Choose **Continue from Flare** (or Sunburst) and confirm only that candidate's final Version becomes active. Reload the page and verify the comparison, evaluation and costs are rehydrated.
7. Use a second project to demonstrate the Generate tab: one preset and one custom prompt, then inspect the queued/failed/retry states and the project costs panel.
8. Stop the web and worker processes before any reset. The five-case table remains `not_run` until real live comparisons are recorded.

## Live evidence and remaining evaluation work

- Live DoD passed on 2026-10-22 with explicit authorization. The successful run made 8 image calls and 4 SAM calls through the normal services; planned-suite cost was USD 0.181416 (provider-reported 171,416 + calculated SAM 10,000 micro-USD). Including two failed attempts and exploratory probes, the session cost USD 0.284654; total observed live spend is approximately USD 0.289654.
- Live OpenRouter Flare and Sunburst both succeeded for preset generation, custom generation, reference-driven comparison, child edit and root branch. Live Meta SAM succeeded for selection and correction on the AI-generated scene and for the licensed-photo recolor case.
- The reference comparison used identical parent/Selection/references/prompt and `commonInputHash` for both models; protected mismatch was 0 and final background MAE was 0. The live SAM mask covered only a cushion, so the final composite preserved most of the original while the raw output replaced the whole sofa. Manual scores and exact Run IDs are in [docs/live-evidence.md](docs/live-evidence.md).
- The fixed **Recolor sofa** case passed for both models. The other four fixed cases remain `not_run`; this is recorded, not inferred from mocks.
- `npm run test:live` is a guarded live DoD runner. It exits before any network call unless `RUN_LIVE_AI_TESTS=1`, `AI_MODE=live`, `SAM_MODE=live`, `LIVE_DOD_APPROVED=1`, both provider keys and licensed photo fixtures are present. When enabled it makes a planned 8 image calls and 4 SAM calls through the normal enqueue/worker/budget/ledger services, writes a dedicated `data/live-dod-*.sqlite` database and `assets-local/live-dod-*` artifacts, and records a safe report in `docs/live-dod-report.json`. Do not enable it without explicit spend approval.

## Licensing

- Code is released under the [MIT License](LICENSE).
- The bundled source and reference photographs are CC0 1.0 public-domain derivatives with permission records in `src/test/fixtures/licenses/`: `Living room (15246771173).jpg` by Carlos ZGZ and `Couch-furniture-living-room-sofa (24300293356).jpg` by www.Pixel.la Free Stock Photos. The source photo is square-cropped/resized; the reference is resized. No people or personal data are visible.
- Synthetic fixture PNGs are generated by this project from project-authored SVG primitives. Do not add personal photographs or raw live captures; any new photo requires a matching permission record under `src/test/fixtures/licenses/`.
- Incidental artwork/posters depicted in the photos are not relicensed by CC0; clear any depicted works before commercial reuse.
- Provider outputs and third-party marks remain subject to the applicable provider terms. Review those terms before publishing generated images or comparison evidence.

## Storage and safety

- SQLite: `./data/scene-composer.sqlite`; private assets: `./assets-local/`; migrations: `./drizzle/`.
- The app is a local, loopback-only, single-user PoC. It has no authentication and must not be exposed to a network or the public internet.
- Provider keys and storage paths remain server-side; they are never exposed through read DTOs, browser configuration or logs. Do not use `NEXT_PUBLIC_` for secrets or paths.
- `agent-memory/`, `.env.local`, local data, local assets and build/test artifacts are gitignored. Do not force-add them.
- **Guarded reset:** stop the web app and worker first, then run `RESET_LOCAL_DATA=1 npm run data:reset`. The script refuses repository/filesystem roots, symlinked targets and custom storage paths outside the dedicated `data/` and `assets-local/` directories; it deletes only the known SQLite database (including WAL/SHM) and validated asset directory, then reapplies committed migrations. Never run `rm -rf` against an environment-selected path.
- The default tests never touch `data/` or `assets-local/`; they use isolated temporary databases and asset directories.

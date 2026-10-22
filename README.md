# AI Scene Composer PoC

AI Scene Composer is a local, single-user demo of an AI-assisted image workflow: create or import a scene, select an object with points, describe a change, and inspect the result. It brings image understanding, image generation and deterministic local compositing together so you can explore how AI changes a scene while retaining control over the source and its history.

This demo is not intended to compete with specialized desktop or online image editors. Its purpose is to demonstrate the capabilities that AI image models offer, including prompt-driven generation, object selection and contextual image editing.

You can edit a selected region or the whole scene, supply up to two reference images, compare **Flare** and **Sunburst** on the same inputs, and inspect raw versus final output, costs and manually scored results. Edits create branches rather than overwriting the original. The default mock mode lets you explore the workflow offline, without credentials or provider charges.

Both models can generate and edit images, but [OpenAI](https://openai.com/index/introducing-chatgpt-images-2-5/) positions Flare as the faster choice for everyday tasks and Sunburst as the more precise choice for detailed creative work, with longer generation times.

## Technology

| Technology | Role and benefit |
|---|---|
| Next.js App Router, React, TypeScript and Tailwind CSS | A responsive local interface with typed UI and API contracts; the scene, selection, results and history stay in one workspace. |
| OpenRouter (Flare and Sunburst) | Image generation and instruction-driven editing; two models can be compared on identical source, prompt and references. Generation uses Flare. |
| Meta SAM 3.1 | Point-guided object segmentation with positive and negative clicks, reducing the need to paint a mask by hand. |
| Sharp and local mask compositing | Images are normalized to a consistent 1024 x 1024 format; selected-region edits preserve pixels outside the allowed region exactly. Whole-scene edits have no such guarantee. |
| SQLite and Drizzle ORM | Local, persistent projects, immutable image versions, selections and usage records without an external database. |
| A single local Node.js worker | Runs provider requests outside the web request, with queued jobs, recovery and explicit cost reservations. |
| Vitest and Playwright | Offline unit, integration and browser tests for the image pipeline and user workflow. |

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- npm with the committed `package-lock.json`
- No provider credentials for the default mock demo

## Setup

```bash
nvm use                  # if nvm is installed; selects Node 24 from .nvmrc
npm ci
cp .env.example .env.local
npm run fixtures:prepare
npm run db:migrate
```

`fixtures:prepare` prepares the bundled sample and reference images; `db:migrate` applies the committed migrations. No manual SQL is needed. For browser tests, also run `npx playwright install chromium`. If npm skips native install scripts and a module fails to load, run `npm rebuild better-sqlite3` (and `npm rebuild esbuild` if needed).

Run the app and worker in two terminals:

```bash
npm run dev
npm run worker
```

Open `http://127.0.0.1:3000`. Keep both processes running: the web app handles the interface, while the worker processes generation, selection and edits. For a production-mode local run, use `npm run build`, `npm run start` and `npm run worker`.

### Development notes

The web app hot-reloads, but the worker does **not** (`tsx src/worker/index.ts` loads the code once).

- Restart `npm run worker` after any change under `src/lib/**`, `src/worker/**` or DTO/schema code. A stale worker fails new runs with confusing errors (for example an old edit handler rejecting a `scope: "scene"` snapshot) even though the UI and API already use the new code.
- Do **not** run `npm run build` while `npm run dev` is running. Both write to `.next`; the build overwrites the dev server's cache and the dev server can then serve stale or broken modules.
- If behavior does not match the current source, stop both processes, clear `.next`, start them again and hard-refresh the browser tab (Ctrl/Cmd+Shift+R).

`npm run typecheck`, `npm run lint` and `npm test` do not need a running server.

## AI modes

- `AI_MODE=mock` (default): deterministic image and selection responses, no provider calls or charges.
- `AI_MODE=live`, `SAM_MODE=fixture`: live OpenRouter generation/editing; SAM selection replays only a matching authentic capture. Without a matching capture, selection is unavailable.
- `AI_MODE=live`, `SAM_MODE=live`: live OpenRouter and Meta SAM; both provider accounts and keys are required for the complete workflow.

Set these values in `.env.local` before starting the processes. `SAM_MODE` has no effect in mock mode. There is no automatic mock fallback in live mode; missing credentials disable the affected function.

## Live providers and privacy

Live mode requires separate provider accounts and budget; mock mode requires neither.

| Provider | Used for | Required value | Data sent |
|---|---|---|---|
| OpenRouter | Generation, edit and comparison | `OPENROUTER_API_KEY` with access to Flare and Sunburst | Prompt; edits also send the source and up to two reference images |
| Meta | Live SAM selection | `META_MODEL_API_KEY` with access to hosted SAM 3.1 | Source image and positive/negative point prompts |

- Keys are read server-side from `.env.local` and are never placed in `NEXT_PUBLIC_` variables, browser configuration, read DTOs or logs. Do not commit `.env.local`.
- Live provider requests leave the local machine. Use only nonpersonal or properly licensed images, review the provider terms for retention/training behavior, and do not send sensitive material without approval.
- The app is a local single-user PoC: it binds to loopback, has no authentication and must not be exposed to a network. Private assets live under `assets-local/`, not `/public`.
- Live actions require cost consent and use a per-project budget; missing or uncertain provider costs are not silently treated as zero. Failed or ambiguous calls are not automatically replayed as paid requests.

## How it works

1. Start a project from the bundled scene, an upload or an AI-generated scene. Generation offers three presets (Cozy Living Room, Scandinavian Dining Room and Minimalist Bedroom) or a custom prompt. Each project has one original scene; edits form a version tree beneath it.
2. For an object edit, click the scene to request a SAM selection. Add positive points with Shift-click or negative points with Alt/Option-click; touch users can use the point-mode buttons. Each new point request creates a new selection and may incur a live SAM charge. Switching between the saved 16/32-pixel padding variants does not call SAM again.
3. Enter an instruction, optionally add up to two ordered reference images, and edit either the **Selection** or the **Whole scene** with Flare or Sunburst. Both models receive the source image and prompt; masks stay local. Selection edits blend the model output into the chosen area and verify exact preservation outside it. Whole-scene edits can change any pixel.
4. Inspect the raw model output alongside the final image, compare it with its parent, or run **Compare Both** for two sibling results from the same inputs. Choose **Continue** to make a result active; earlier versions remain available. The project also tracks provider costs, retries and optional manual evaluation.

Editable scenes are normalized to opaque 1024 x 1024 sRGB PNGs. Original uploads, raw provider outputs and final images are stored separately in private local storage. See the [implementation plan](./AI_SCENE_COMPOSER_POC_PLAN.md) for API contracts, mask mathematics and persistence rules.

## Fixture slots

The bundled scene and reference use CC0 photographs with recorded permissions. `npm run fixtures:prepare` also generates deterministic synthetic alternatives for isolated tests or fixture roots without photos:

| Slot | Photograph | Permission record |
|---|---|---|
| `living-room-v1` | `src/test/fixtures/photos/living-room-v1.jpg` (2048 x 2048, CC0 derivative) | `src/test/fixtures/licenses/living-room-v1.md` |
| `reference-sofa-v1` | `src/test/fixtures/photos/reference-sofa-v1.jpg` (1600 x 1061, CC0 derivative) | `src/test/fixtures/licenses/reference-sofa-v1.md` |

The fixture manifest records provenance and hashes. A photograph needs its matching permission record; the synthetic images are not substitutes for licensed photos in live verification.

## SAM fixture captures

`SAM_MODE=fixture` can replay an authentic completed SAM capture only when its source hash, normalization version, model and point arrays match exactly. The capture slots are:

- `src/test/fixtures/sam/living-room-v1.positive.json` for a positive-only request
- `src/test/fixtures/sam/living-room-v1.negative.json` for a positive plus negative request

The repository does not fabricate captures. Without a match, fixture selection returns `PROVIDER_UNAVAILABLE` without a charge; use mock mode for a fully offline walkthrough or live mode with Meta access for real segmentation.

## Commands

```bash
npm run dev              # Next.js app on 127.0.0.1
npm run worker           # single Node worker
npm run fixtures:prepare # offline synthetic/photo fixture preparation
npm run db:generate      # generate Drizzle migrations after a schema change
npm run db:migrate       # apply committed migrations
npm run check:contracts  # offline provider/config contract check
npm test                 # Vitest unit and integration tests
npm run typecheck        # strict TypeScript
npm run lint             # ESLint
npm run build            # production build
npm run test:e2e         # Playwright mock generation, SAM selection, editing, comparison and mobile/a11y
npm run test:live        # guarded, paid live provider test (see below)
RESET_LOCAL_DATA=1 npm run data:reset
```

`data:reset` is destructive, requires stopped web/worker processes and refuses custom storage paths outside the dedicated `data/` and `assets-local/` directories.

## Costs and evaluation

The app displays a reservation before each live action and tracks costs and uncertain holds by operation and model. The SAM cost of a selection shared by a two-model comparison is counted once; a whole-scene comparison needs no selection. A failed candidate can be retried independently without rerunning its successful sibling. Provider charges depend on the provider and may differ from local reservations.

You can rate successful edits from 1 to 5 for boundary artifacts, prompt adherence, reference fidelity (when a reference was supplied) and plausibility. Evaluations are optional and belong to the individual edit result, not the image version.

## Five-case evaluation

The [case definitions](src/test/fixtures/evaluation/cases.json) provide five repeatable comparison scenarios. Each model uses the same source, prompt and references, so differences in the two outputs can be inspected alongside latency, cost and manual scores. These are scenarios, not an aggregate model ranking.

| Scenario | What to inspect |
|---|---|
| Recolor sofa | Color change and preservation of the surrounding scene |
| Replace lamp from a reference | Reference fidelity and object boundaries |
| Remove wall picture | Background reconstruction |
| Change object material | Texture and lighting consistency |
| Change chair | Shape, context and plausibility |

Actual paid-run evidence and limitations are documented separately in [live evidence](docs/live-evidence.md); mock results are not live model evidence.

## Testing

The default suite is offline and zero-cost: it uses mock models, blank provider keys and temporary databases and asset directories. It does not touch your local projects.

| Command | Coverage |
|---|---|
| `npm test` | Unit and integration tests, including provider contracts, exact mask/composite math, retries, idempotency, worker recovery, comparison atomicity, cost partitions, evaluation validation, secret/path leaks and repository hygiene |
| `npm run test:e2e` | Mock generation, multi-point SAM selection, selection/whole-scene editing, comparison/evaluation, mobile layout and basic accessibility |
| `npm run typecheck` | Strict TypeScript |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run check:contracts` | Offline provider/config contract check; no network, keys or paid probes |
| `npm run db:generate` | Should report no schema drift when migrations are current |

For detailed test coverage, see the [test matrix](docs/test-matrix.md). Selection and editing behavior is described in [selection and edit modes](docs/selection-and-edit-modes.md); past live runs are recorded in [live evidence](docs/live-evidence.md).

## Demo walkthrough (mock, no keys)

1. Start the app and worker as described in [Setup](#setup), then open `http://127.0.0.1:3000`.
2. Click **New Scene** and **Use Bundled Sample** to load the living-room photograph. You can also upload a scene or create a new project to try a generation preset or custom prompt.
3. Click an object in the scene to make a selection. Try Shift-click to add a positive point, Alt/Option-click to add a negative point, and switch between the saved padding variants.
4. Under **Edit**, choose **Selection** or **Whole scene**, enter an instruction and optionally add a reference such as `src/test/fixtures/photos/reference-sofa-v1.jpg`. Choose Flare or Sunburst, accept the displayed cost consent and run the edit.
5. Inspect raw and final images and the before/after slider. Use **Compare Both** on the same input to see two sibling results, then add a manual evaluation if useful.
6. Click **Continue** on the result you prefer. Reload the page to see its version history, comparison and costs persist.

## Live testing

`npm run test:live` makes paid provider calls. It exits before network access unless `RUN_LIVE_AI_TESTS=1`, `AI_MODE=live`, `SAM_MODE=live`, `LIVE_DOD_APPROVED=1`, both provider keys and licensed photographs are available. When deliberately enabled, it plans eight image calls and four SAM calls, uses separate local data/assets and writes a report to `docs/live-dod-report.json`. Do not enable it without explicit approval for the expected spend. See [live evidence](docs/live-evidence.md) for recorded observations and limitations.

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
- **Guarded reset:** stop the web app and worker first, then run `RESET_LOCAL_DATA=1 npm run data:reset`. The script checks its targets, removes only the dedicated local database/assets and reapplies migrations. Never run `rm -rf` against an environment-selected path.

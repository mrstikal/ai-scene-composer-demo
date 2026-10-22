# AI Scene Composer PoC

Local single-user Next.js application for scene upload/sample, version history and, in later phases, AI generation, SAM selection and object-aware editing. The delivery contract is [AI_SCENE_COMPOSER_POC_PLAN.md](./AI_SCENE_COMPOSER_POC_PLAN.md).

Current implementation: **Phase 2 preset and custom AI scene creation**. Upload, bundled sample, project/version read-back, health, worker foundation, deterministic mock adapters, and preset/custom generation through the real queue, receipts, root creation and cost accounting are implemented. SAM selection and editing are added in later phases.

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
npm run test:e2e         # Playwright mock preset/custom generation
npm run test:live        # guarded opt-in live smoke (later phases)
RESET_LOCAL_DATA=1 npm run data:reset
```

`data:reset` is destructive, requires stopped web/worker processes and refuses custom storage paths outside the dedicated `data/` and `assets-local/` directories.

## Generation

The Generate tab offers exactly three server-resolved presets and a Custom Prompt option. Preset text is read-only and resolved on the server; custom text is trimmed and limited to 1-2000 characters. The form requires explicit cost consent showing the current pricing version and reservation.

`POST /api/generations` requires an `Idempotency-Key`, accepts only an empty project, and returns `202 {runId}`. The worker calls the selected adapter exactly once, persists raw/canonical assets, a durable receipt and a UsageEvent, then atomically installs the root. Mock generation returns the labeled synthetic scene with a zero calculated charge; it still exercises the real queue, receipt, root and accounting paths. A late generation that loses the root race keeps its artifacts/cost and fails with `ROOT_ALREADY_EXISTS`. Failed or ambiguous runs expose a server-derived retry mode; receipt-only local retries reuse the same Run without another provider call.

## Storage and safety

- SQLite: `./data/scene-composer.sqlite`
- Private assets: `./assets-local/`
- Provider keys and storage paths remain server-side; they are never exposed through read DTOs or logs.
- `agent-memory/`, `.env.local`, local data, local assets and build/test artifacts are gitignored.

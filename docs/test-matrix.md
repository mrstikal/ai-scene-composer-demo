# Test Matrix

Last updated: 2026-10-22, after the post-DoD multi-point selection and edit-scope work. This maps the plan's acceptance checklist to automated and observed live evidence. Current baseline: 35 Vitest files / 208 tests and 16 Playwright mock tests; the live DoD is recorded separately in [live evidence](live-evidence.md). Feature details are in [Selection and edit modes](selection-and-edit-modes.md) and [Action feedback](ui-feedback.md).

## Offline Implementation

| Acceptance item | Evidence | Status |
|---|---|---|
| Fresh setup with mock mode, no credentials or provider traffic | [Setup verification](setup-verification.md); `npm ci`, `fixtures:prepare`, `db:migrate`; [repository hygiene](../src/test/unit/repository-hygiene.test.ts) | pass |
| Upload and bundled sample create canonical roots with preserved originals | [Projects integration](../src/test/integration/projects.test.ts), [routes integration](../src/test/integration/routes.test.ts) | pass |
| Missing photos use labeled synthetic sample/reference; manifest hashes/provenance persist | [Fixture preparation](../src/test/unit/fixtures-prepare.test.ts), [health](../src/test/unit/health.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Exactly three presets and a custom prompt create generated roots | [Presets](../src/test/unit/presets.test.ts), [generations](../src/test/integration/generations.test.ts), [generation e2e](../src/test/e2e/generation.spec.ts) | pass |
| Generation queue/failure/retry and reload before a root exists | [Generations](../src/test/integration/generations.test.ts), [worker recovery](../src/test/integration/worker.test.ts), [generation e2e](../src/test/e2e/generation.spec.ts) | pass |
| Off-center SAM crop placement and point correction | [Mask pipeline](../src/test/unit/mask-pipeline.test.ts), [segmentations](../src/test/integration/segmentations.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts) | pass |
| Multi-point selection: Shift adds positive, Alt/Option subtracts, 1-8 positive and 0-8 negative points, duplicates rejected | [SAM unit](../src/test/unit/sam.test.ts), [mock mask](../src/test/unit/mocks.test.ts), [segmentations](../src/test/integration/segmentations.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts), [feature doc](selection-and-edit-modes.md#1-multi-point-sam-selection) | pass (mock/fixture) |
| Padding 16/32 and 8 px inward feather are deterministic and do not call SAM again | [Mask pipeline](../src/test/unit/mask-pipeline.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts) | pass |
| Source plus 0-2 references keep stable order; no unsupported provider fields | [Edit prompt](../src/test/unit/edit-prompt.test.ts), [OpenRouter](../src/test/unit/openrouter.test.ts), [edits](../src/test/integration/edits.test.ts) | pass |
| Raw, normalized and final images are distinct inspectable artifacts | [Edits](../src/test/integration/edits.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Protected-pixel mismatch is zero for successful edits with protected pixels | [Composite](../src/test/unit/composite.test.ts), [edits](../src/test/integration/edits.test.ts) | pass |
| Root -> A -> B and root -> C survive reload with immutable previous assets | [Edits](../src/test/integration/edits.test.ts), [editing e2e](../src/test/e2e/editing.spec.ts) | pass |
| Whole-scene edit needs no SAM selection, persists `scope: scene`, skips compositing and warns about no protected pixels | [Edit prompt](../src/test/unit/edit-prompt.test.ts), [edits](../src/test/integration/edits.test.ts), [editing e2e](../src/test/e2e/editing.spec.ts), [feature doc](selection-and-edit-modes.md#2-whole-scene-editing) | pass (mock) |
| Both comparison candidates use identical frozen input and survive partial failure | [Comparisons](../src/test/integration/comparisons.test.ts), [comparison e2e](../src/test/e2e/comparison.spec.ts) | pass |
| Whole-scene comparison requires no selection, shares one hash and reports no shared SAM cost | [Comparisons](../src/test/integration/comparisons.test.ts), [comparison e2e](../src/test/e2e/comparison.spec.ts), [feature doc](selection-and-edit-modes.md#comparison) | pass (mock) |
| Scores, costs/provenance, initial spend, reservations and unknown holds persist | [Costs unit](../src/test/unit/costs.test.ts), [costs integration](../src/test/integration/costs.test.ts), [comparisons](../src/test/integration/comparisons.test.ts), [comparison e2e](../src/test/e2e/comparison.spec.ts) | pass |
| Idempotency, atomic budget checks and restart cannot duplicate provider calls | [Generations](../src/test/integration/generations.test.ts), [worker recovery](../src/test/integration/worker.test.ts), [comparisons](../src/test/integration/comparisons.test.ts) | pass |
| Desktop/mobile controls work; keys, paths and private payloads are not exposed | [Mobile/accessibility e2e](../src/test/e2e/accessibility.spec.ts), [selection e2e](../src/test/e2e/selection.spec.ts), [security integration](../src/test/integration/security.test.ts), [repository hygiene](../src/test/unit/repository-hygiene.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Running actions show a spinner, completed actions flash for 3 s or close via X, errors persist until X | [Action feed unit](../src/test/unit/action-feed.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts), [editing e2e](../src/test/e2e/editing.spec.ts), [feature doc](ui-feedback.md) | pass (mock) |
| Comparison panel is full-width/responsive and Scene/Comparison images open at full resolution | [Feature doc](selection-and-edit-modes.md#3-comparison-layout-and-full-resolution-links), [selection](../src/test/e2e/selection.spec.ts), [comparison](../src/test/e2e/comparison.spec.ts) | pass (manual 1440/390 screenshots + e2e) |
| Lint, typecheck, offline tests, build and browser tests pass | [Setup verification](setup-verification.md); `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` | pass |

## Full Live PoC

| Acceptance item | Evidence | Status |
|---|---|---|
| Both OpenRouter models and hosted Meta SAM verified with actual accounts | [Live evidence](live-evidence.md) | pass: Flare, Sunburst and SAM 3.1 succeeded on 2026-10-22 |
| Nonpersonal sample/reference photos and permission records supplied | [Fixture slots](../README.md#fixture-slots), `src/test/fixtures/licenses/` | pass: CC0 source/reference photos with records |
| Preset and custom generated scenes with observed cost/provenance | [Live evidence](live-evidence.md) | pass: Flare preset 13,705 micro-USD; custom 13,360 micro-USD, provider-reported |
| Real SAM selection/correction aligned on an AI-generated scene | [Live evidence](live-evidence.md) | pass: SAM 3.1 positive and correction calls on the preset root; mask limitation documented |
| Reference-driven Flare/Sunburst comparison with both costs and latency | [Live evidence](live-evidence.md), [five-case table](../README.md#five-case-evaluation) | pass: identical hash/parent, provider costs 27,914 each; recolor case passed |
| Continue result and persist another edit/branch across restart | [Live evidence](live-evidence.md) | pass: child edit and root branch survived close/reopen |
| Protected RGB pixels exactly preserved; boundary artifacts documented | [Live evidence](live-evidence.md) | pass: protected mismatch 0, final MAE 0; SAM mask boundary limitation documented |
| README demo steps, mode limits and remaining evaluation rows | [README](../README.md), [five-case table](../README.md#five-case-evaluation) | pass: Recolor sofa passed; four fixed cases remain `not_run` |

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run check:contracts

# Live DoD only with explicit approval; makes 8 image + 4 SAM paid calls.
RUN_LIVE_AI_TESTS=1 AI_MODE=live SAM_MODE=live LIVE_DOD_APPROVED=1 npm run test:live
```

The default suite uses mock generation, fixture SAM and blank provider keys. It must not spend money or require network access. The live DoD is recorded in [live evidence](live-evidence.md).

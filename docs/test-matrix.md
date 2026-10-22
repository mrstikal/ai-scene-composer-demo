# Test Matrix

Last updated: 2026-10-22, after Phase 5 and Phase 6 hardening. This maps the plan's acceptance checklist to automated evidence. Live rows are not inferred from mocks. Current baseline: 32 Vitest files / 178 tests and 12 Playwright mock tests.

## Offline Implementation

| Acceptance item | Evidence | Status |
|---|---|---|
| Fresh setup with mock mode, no credentials or provider traffic | [Setup verification](setup-verification.md); `npm ci`, `fixtures:prepare`, `db:migrate`; [repository hygiene](../src/test/unit/repository-hygiene.test.ts) | pass |
| Upload and bundled sample create canonical roots with preserved originals | [Projects integration](../src/test/integration/projects.test.ts), [routes integration](../src/test/integration/routes.test.ts) | pass |
| Missing photos use labeled synthetic sample/reference; manifest hashes/provenance persist | [Fixture preparation](../src/test/unit/fixtures-prepare.test.ts), [health](../src/test/unit/health.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Exactly three presets and a custom prompt create generated roots | [Presets](../src/test/unit/presets.test.ts), [generations](../src/test/integration/generations.test.ts), [generation e2e](../src/test/e2e/generation.spec.ts) | pass |
| Generation queue/failure/retry and reload before a root exists | [Generations](../src/test/integration/generations.test.ts), [worker recovery](../src/test/integration/worker.test.ts), [generation e2e](../src/test/e2e/generation.spec.ts) | pass |
| Off-center SAM crop placement and point correction | [Mask pipeline](../src/test/unit/mask-pipeline.test.ts), [segmentations](../src/test/integration/segmentations.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts) | pass |
| Padding 16/32 and 8 px inward feather are deterministic and do not call SAM again | [Mask pipeline](../src/test/unit/mask-pipeline.test.ts), [selection e2e](../src/test/e2e/selection.spec.ts) | pass |
| Source plus 0-2 references keep stable order; no unsupported provider fields | [Edit prompt](../src/test/unit/edit-prompt.test.ts), [OpenRouter](../src/test/unit/openrouter.test.ts), [edits](../src/test/integration/edits.test.ts) | pass |
| Raw, normalized and final images are distinct inspectable artifacts | [Edits](../src/test/integration/edits.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Protected-pixel mismatch is zero for successful edits with protected pixels | [Composite](../src/test/unit/composite.test.ts), [edits](../src/test/integration/edits.test.ts) | pass |
| Root -> A -> B and root -> C survive reload with immutable previous assets | [Edits](../src/test/integration/edits.test.ts), [editing e2e](../src/test/e2e/editing.spec.ts) | pass |
| Both comparison candidates use identical frozen input and survive partial failure | [Comparisons](../src/test/integration/comparisons.test.ts), [comparison e2e](../src/test/e2e/comparison.spec.ts) | pass |
| Scores, costs/provenance, initial spend, reservations and unknown holds persist | [Costs unit](../src/test/unit/costs.test.ts), [costs integration](../src/test/integration/costs.test.ts), [comparisons](../src/test/integration/comparisons.test.ts), [comparison e2e](../src/test/e2e/comparison.spec.ts) | pass |
| Idempotency, atomic budget checks and restart cannot duplicate provider calls | [Generations](../src/test/integration/generations.test.ts), [worker recovery](../src/test/integration/worker.test.ts), [comparisons](../src/test/integration/comparisons.test.ts) | pass |
| Desktop/mobile controls work; keys, paths and private payloads are not exposed | [Mobile/accessibility e2e](../src/test/e2e/accessibility.spec.ts), [selection e2e](../src/test/e2e/selection.spec.ts), [security integration](../src/test/integration/security.test.ts), [repository hygiene](../src/test/unit/repository-hygiene.test.ts), [projects](../src/test/integration/projects.test.ts) | pass |
| Lint, typecheck, offline tests, build and browser tests pass | [Setup verification](setup-verification.md); `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` | pass |

## Full Live PoC

| Acceptance item | Evidence | Status |
|---|---|---|
| Both OpenRouter models and hosted Meta SAM verified with actual accounts | [Live evidence](live-evidence.md) | partial: live Meta SAM verified once; OpenRouter not exercised |
| Nonpersonal sample/reference photos and permission records supplied | [Fixture slots](../README.md#fixture-slots) | blocked: synthetic fixtures only |
| Preset and custom generated scenes with observed cost/provenance | [Live evidence](live-evidence.md) | blocked: no approved live OpenRouter run |
| Real SAM selection/correction aligned on an AI-generated scene | [Live evidence](live-evidence.md) | blocked: SAM was verified on the synthetic sample, not an AI-generated scene |
| Reference-driven Flare/Sunburst comparison with both costs and latency | [Live evidence](live-evidence.md), [five-case table](../README.md#five-case-evaluation) | blocked: no paid comparison approval |
| Continue result and persist another edit/branch across restart | Mock coverage only | blocked live |
| Protected RGB pixels exactly preserved; boundary artifacts documented | Local diagnostics covered by tests | blocked live |
| README demo steps, mode limits and remaining evaluation rows | [README](../README.md), [five-case table](../README.md#five-case-evaluation) | pass |

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run check:contracts
```

The default suite uses mock generation, fixture SAM and blank provider keys. It must not spend money or require network access.

# Live Evidence

Last updated: 2026-10-22. This file records only observed live behavior. Mock/fixture runs, simulated adapter results and screenshots are not live evidence.

## Authorization and Scope

- The user explicitly authorized all paid calls on 2026-10-22.
- All live calls went through the normal enqueue/worker/budget/UsageEvent services. No unmetered side script called a provider.
- Dedicated live databases and private assets were retained under `data/live-dod-*.sqlite` and `assets-local/live-dod-*` (gitignored).
- No automatic retry was made on an unknown outcome. The two failed attempts stopped on definitive `INVALID_SELECTION` errors.

## Live DoD Result: PASSED

Command:

```bash
RUN_LIVE_AI_TESTS=1 AI_MODE=live SAM_MODE=live LIVE_DOD_APPROVED=1 npm run test:live
```

Successful run: `data/live-dod-2026-10-22T13-57-03-760Z.sqlite`, assets `assets-local/live-dod-2026-10-22T13-57-03-760Z`, safe report `docs/live-dod-report.json`.

- Planned and completed: 8 image calls and 4 SAM calls.
- Planned-suite cost: 181,416 micro-USD = USD 0.181416 (provider-reported 171,416 + calculated SAM 10,000).
- Session total including two failed attempts and four exploratory SAM probes: 284,654 micro-USD = USD 0.284654.
- Earlier authorized SAM-only check: approximately 5,000 micro-USD. Overall observed live spend to date: approximately USD 0.289654.

## Successful Run Evidence

| Project / step | Model | Run ID | Latency | Amount | Provenance |
|---|---|---|---|---|---|
| Walkthrough / preset generation | `openai/gpt-image-2.5-flare` | `fb6123b7-e8ea-4df5-9e22-141e6f2c7984` | 12,698 ms | 13,705 | provider |
| Walkthrough / SAM positive | `sam-3.1` | `02a1a394-e22a-4a3f-9d48-4fa47d81e9d2` | 789 ms | 2,500 | calculated |
| Walkthrough / SAM correction | `sam-3.1` | `e6b0b7ee-1bf6-4b42-9514-9f64bc24bf5e` | 833 ms | 2,500 | calculated |
| Walkthrough / reference comparison Flare | `openai/gpt-image-2.5-flare` | `88d215fd-237f-4a65-88de-d8ce5a6ba907` | 19,844 ms | 27,914 | provider |
| Walkthrough / reference comparison Sunburst | `openai/gpt-image-2.5-sunburst` | `0a048d56-531a-49f5-bf22-4f10139c5b22` | 27,121 ms | 27,914 | provider |
| Walkthrough / child SAM | `sam-3.1` | `2d15101a-e053-48b2-a13f-64ab987ded66` | 1,037 ms | 2,500 | calculated |
| Walkthrough / child edit Flare | `openai/gpt-image-2.5-flare` | `6ad6608d-9821-49b0-ba42-9becad5b8b61` | 17,251 ms | 22,117 | provider |
| Walkthrough / root branch Sunburst | `openai/gpt-image-2.5-sunburst` | `aff2950e-faa9-4e7b-9c60-692d282deb08` | 25,726 ms | 22,132 | provider |
| Custom prompt / generation | `openai/gpt-image-2.5-flare` | `bb710d92-baf9-441c-86bd-c0071b981af7` | 12,754 ms | 13,360 | provider |
| Recolor sofa / SAM | `sam-3.1` | `001f749c-5b85-4862-a964-de0b2f7df24f` | 1,058 ms | 2,500 | calculated |
| Recolor sofa / Flare | `openai/gpt-image-2.5-flare` | `1dcfadce-5525-42d5-866d-224078312d19` | 20,993 ms | 22,137 | provider |
| Recolor sofa / Sunburst | `openai/gpt-image-2.5-sunburst` | `1565155d-42bc-4743-8072-fde997ff186d` | 30,177 ms | 22,137 | provider |

## Reference-Driven Comparison

- Parent Version: `0c06b608-b64e-4dbc-8eec-4c4371cf811c` (preset-generated root).
- Selection: `fecce7b2-e223-482a-9032-91b9099b8e4c`; live SAM selected a cushion-sized region, not the whole sofa.
- Comparison group: `c436a266-fef1-4408-98ef-1b0ef5a99c8b`.
- Both initial Runs have the same parent, Selection, references, prompt and `commonInputHash`: `67da4aa0ab63176764ecc0e27f35694965ffc4911b57a986eb3162e8b17776c3`.
- Flare output Version `6ed0114a-fa6d-41cf-93cb-b6a53c7a0595`; Sunburst output Version `78b8333f-27d2-442a-9089-8f20763639d6`.
- Both: native/normalized 1024 x 1024, protected pixels 1,040,909, protected mismatch 0, raw background MAE about 16.7 / 16.6, final background MAE 0.
- Cost attribution: the corrected SAM Selection run `e6b0b7ee-1bf6-4b42-9514-9f64bc24bf5e` contributes 2,500 micro-USD once; candidate cost is 55,828 micro-USD (27,914 per model), not duplicated per candidate.
- Observed raw output: both models replaced the whole sofa with the black tufted leather reference. Observed final composite: only the small SAM-selected cushion region could change, so the final image looks close to the original. This is a live selection-mask limitation, not a raw model failure; the UI raw/final toggle exposes it.
- Manual scores: Flare and Sunburst both boundary artifacts 4, prompt adherence 1, reference fidelity 1, plausibility 4. Notes are stored on the Runs.

## Five-Case Evaluation

Only the fixed **Recolor sofa** case has been executed live. The other four remain `not_run`.

- Source: licensed CC0 `living-room-v1` sample; root `edd0fc13-3dee-462a-ad78-be9a2271c519`.
- Selection `09705d4d-8eb2-4b77-9e5e-e40493780f10`; comparison group `764d19b1-a9ae-4c72-8b10-b2e624111816`; identical `commonInputHash` `8c9274fbb58d4df6841b069da4501c71dd2a02bd7220879ceae5cf1f2b997755`.
- Flare output `131c427f-c2f1-4672-b961-4e317939e2a1`; Sunburst output `0100f758-1715-4e20-88f6-07adc97edc24`.
- Both produced a deep green velvet sofa while preserving pillows, lamp, wall art and room; protected mismatch 0, final background MAE 0, protected pixels 808,755, raw background MAE 5.683 (Flare) / 5.273 (Sunburst).
- Cost attribution: SAM run `001f749c-5b85-4862-a964-de0b2f7df24f` contributes 2,500 micro-USD once; candidate cost is 44,274 micro-USD (22,137 per model).
- Manual scores for both: boundary artifacts 4, prompt adherence 5, reference fidelity null, plausibility 5.

## Continue, Branch and Restart

- Continue selected the Flare comparison result `6ed0114a-fa6d-41cf-93cb-b6a53c7a0595` as active.
- A live child Selection (`e508b3ef-0e77-42f2-9de9-ac5a012db710`) and Flare edit created child Version `9e8a15bf-5e84-4921-bae8-50a5a27cf589`; the amber lamp shade is visible, protected mismatch is 0, final MAE 0 and raw MAE 6.882.
- Returning to the root and editing with Sunburst created second branch Version `867e72ab-b6ff-4612-ba4b-3f0a81b0b83b`; protected mismatch 0, final MAE 0 and raw MAE 16.149. The final shows only a narrow green strip because the SAM mask was a cushion; this is documented in the evaluation notes.
- The script closed and reopened the database, then verified the walkthrough Versions, custom root and recolor root survived. A post-run audit re-read all 56 assets: 0 missing, 0 SHA-256/size mismatches; 9 Version images, 8 raw assets and 6 manual evaluations are persisted in the retained database.

## Observed Failures and Exploratory Probes

| Attempt | Observation | Cost |
|---|---|---|
| First walkthrough attempt | SAM point `(512,650)` missed the sofa on the generated scene: `INVALID_SELECTION` | 16,205 micro-USD (generation 13,705 + SAM 2,500) |
| Second walkthrough attempt | Child SAM point `(900,300)` missed the lamp: `INVALID_SELECTION`; earlier steps succeeded | 82,033 micro-USD, including two exploratory SAM probes |
| Successful-DB probes | Two extra SAM probes at `(500,640)` and `(800,600)` to inspect mask geometry | 5,000 micro-USD |
| Earlier SAM-only check | Two calls; first `INVALID_SELECTION`, second completed in 83 ms with request `resp_6ad978dae79c1850b4b54c1f` and a 12,589-pixel mask | approximately 5,000 micro-USD |

## Evidence to Preserve

- `docs/live-dod-report.json` — safe successful-run report with Run IDs, costs, latency, metrics and project costs.
- `data/live-dod-*.sqlite` — retained live databases, including failed attempts.
- `assets-local/live-dod-*` — private raw, normalized and final assets.
- `src/test/fixtures/licenses/` — CC0 permission records for the source and reference photographs.

Do not commit API keys, absolute storage paths, provider request bodies or private image bytes.

## Post-DoD Changes (Not Live-Verified)

The multi-point SAM selection, whole-scene edit/comparison, responsive comparison layout and full-resolution image links were added after the live DoD. They are covered by mock/fixture integration and Playwright tests only. No paid SAM or OpenRouter calls were made for these changes, so they are **not** live evidence. Details and limits are in [Selection and Edit Modes](selection-and-edit-modes.md).

# Live Evidence

Last updated: 2026-10-22. This file records only observed live behavior. Mock/fixture runs, simulated adapter results and screenshots are not live evidence.

## Authorization and Scope

- Live Meta SAM calls were made manually on 2026-10-22 with explicit user authorization against a temporary local database.
- No paid OpenRouter generation, edit or comparison has been run.
- No further live calls were made during Phase 5/6 hardening. `npm run test:live` remains a guard and makes no provider calls.

## Live Meta SAM

| Attempt | Point | Result | Observed cost |
|---|---|---|---|
| 1 | `(512, 500)` | Meta returned the left cushion box `x=331..510`; the point lay in the gap between cushions, so the run failed `INVALID_SELECTION` | billed; approximately USD 0.0025 |
| 2 | `(450, 500)` | Succeeded in 83 ms, request ID `resp_6ad978dae79c1850b4b54c1f`; 1024 x 1024 one-channel mask with 12,589 on pixels | calculated `meta/live/completed` charge of 2,500 micro-USD |

- Total observed live SAM spend: approximately USD 0.005 for two calls.
- The failed first call is preserved as an observed failure, not hidden. It shows that point placement must be verified against the returned object box.
- No authentic `captured-live` SAM fixture exists. Fixture mode therefore reports `fixture_missing`; it must not fabricate a mask.

## Live OpenRouter

- Not exercised: no live generation, edit or comparison has been run against an account.
- Therefore there is no observed OpenRouter latency, output quality, provider-reported cost or failure data.
- The offline contract check and adapter unit tests validate payload shape only; they do not prove account access, model entitlement or live output.

## Paid Flare/Sunburst Comparison

- Not run. The five-case evaluation table remains `not_run`.
- Missing gates:
  1. Explicit approval for the planned paid call count and budget.
  2. Confirmed OpenRouter access to both `openai/gpt-image-2.5-flare` and `openai/gpt-image-2.5-sunburst`.
  3. A nonpersonal licensed reference photograph and permission record for the reference-driven case.
  4. A clean project with a successful Selection and enough remaining budget for two image reservations plus retries.

## Evidence to Capture for a Future Live Run

For each executed case, record:

- project/root Version and Selection IDs, padding, reference IDs/hashes, prompt and transport parameters;
- Flare and Sunburst Run IDs, status, provider latency and output asset IDs;
- cost amount and provenance per Run, including retries and unknown holds;
- normalized-raw background MAE, final protected MAE/mismatch count and native/normalized dimensions;
- manual 1-5 scores and notes, plus an honest description of boundary artifacts or raw drift;
- exact failures and charges, not only successful screenshots.

Do not record API keys, absolute storage paths, provider request bodies or private image bytes in this file.

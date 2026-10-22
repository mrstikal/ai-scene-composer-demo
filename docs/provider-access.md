# Provider Access Requirements

Checked: 2026-10-21; live Meta SAM evidence added 2026-10-22. This record contains no credentials. No paid OpenRouter probe has been made.

| Provider | Required operations | Credential | Billing | Access status |
|---|---|---|---|---|
| OpenRouter | Initial scene generation with Flare; editing and comparison with Flare and Sunburst | `OPENROUTER_API_KEY` | Separate OpenRouter account | `not_verified` |
| Meta | Live SAM 3.1 segmentation | `META_MODEL_API_KEY` | Separate Meta account | `verified_manually_2026-10-22` |

## What each account enables

- OpenRouter is required for both image operations: generation and editing. A comparison needs access to both selected image models.
- Meta is required only for live segmentation. OpenRouter access alone still permits upload, generation, editing and comparison, but not a live SAM selection.
- Mock mode needs neither account and must make no network calls, even when real keys exist.
- Missing Meta access must not disable otherwise configured OpenRouter generation or editing. It disables live segmentation only.
- SAM fixture mode is not a substitute for a live account. It requires an authentic capture matching the exact canonical source hash, normalization version and supported points. Without one, return `PROVIDER_UNAVAILABLE`; never fabricate a mask or paste an unrelated sample mask.

## Secret handling

- Keep both keys server-side. Never expose them through browser configuration, read models, logs, fixtures or error messages.
- Never print secret values while checking account access. Check account/model availability through the provider dashboard or a non-paid account endpoint.
- A documentation check does not verify account access, credit balance, rate limits or model entitlement.

## Live-access verification

When explicitly authorized, verify access before any automated paid test:

1. Confirm the OpenRouter key can see both `openai/gpt-image-2.5-flare` and `openai/gpt-image-2.5-sunburst`.
2. Confirm the Meta key can access `sam-3.1` and the Responses endpoint.
3. Confirm budget/spend limits and the planned call count.
4. No automated paid live suite is enabled. `npm run test:live` is a guard that makes no calls; any future live run requires `RUN_LIVE_AI_TESTS=1`, `AI_MODE=live`, `SAM_MODE=live`, both credentials, licensed photographs/permission records, a documented budget/call count and explicit human authorization. See `docs/live-evidence.md`.

The Phase 0 gate verifies public documentation, not live access. Live Meta SAM was verified manually on 2026-10-22 with two calls (approximately USD 0.005); OpenRouter generation/edit and a paid Flare/Sunburst comparison remain unverified/blocked. See `docs/live-evidence.md`.

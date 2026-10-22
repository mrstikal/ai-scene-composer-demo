# Phase 0 Provider Contract Freeze

Checked: 2026-10-21. This document freezes the public provider contracts used by the PoC. It records documentation evidence, not live account access, model output or charges. No paid probe was made.

## Gate status

| Item | Status |
|---|---|
| Required public capabilities | Pass |
| Precise blocker | None |
| Live account access | `not_verified` |
| Live model output/latency/cost | `not_verified` |
| Offline implementation with labeled mocks | May proceed |

Machine-readable snapshots:

- `src/config/provider-capabilities.json` — capabilities, fixed request policy, contract freeze and account access.
- `src/config/pricing.json` — dated rates, reservations and the capability version.
- `src/test/fixtures/providers/` — redacted documented examples, explicitly separated from live captures.

## OpenRouter image contract

### Verified facts

- Both models exist and are served by the OpenAI provider:
  - `openai/gpt-image-2.5-flare`
  - `openai/gpt-image-2.5-sunburst`
- The model pages reference dated endpoint aliases (`...-20260908`), while the endpoint records queried through the undated path return the undated model IDs. Persist the requested ID and any returned/resolved ID at run time; do not silently switch the requested alias.
- The dedicated endpoint is `POST https://openrouter.ai/api/v1/images`.
- The advertised provider is `provider_name: "OpenAI"`, `provider_slug: "openai"`, `provider_tag: "openai"`.
- Both endpoint records advertise:
  - `aspect_ratio`: `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `auto`
  - `quality`: `auto`, `low`, `medium`, `high`, `xhigh`, `max`
  - `background`: `auto`, `transparent`, `opaque`
  - `n`: integer range 1-10
  - `input_references`: integer range 0-16
  - `output_compression`: integer range 0-100
  - passthrough parameter `moderation`
  - native streaming support
- Neither endpoint advertises `mask`, `size`, `output_format` or `seed`.
- Token rates for both models:
  - text input: USD 5 / million tokens (`0.000005` per token)
  - image input: USD 8 / million tokens (`0.000008` per token)
  - image output: USD 30 / million tokens (`0.00003` per token)
- Completed generations are billed in full. Definitive failed generations are not billed. A client-observed timeout or lost response is not proof of a definitive failure.

### Frozen request policy

- Initial generation uses Flare only, with `input_references` omitted entirely.
- Editing uses the selected model with the canonical source image first and zero, one or two ordered user references afterward. The total is one to three images. The app supports two scopes: a selection edit that composites through a local mask, and a whole-scene edit that accepts the complete generated frame with no protected-pixel guarantee. The model call itself is identical; no mask is sent to the provider.
- Both operations send the same fixed fields: `aspect_ratio: "1:1"`, `quality: "medium"`, `background: "opaque"`, `n: 1`, and `provider: { only: ["openai"], allow_fallbacks: false }`.
- Do not send `mask`, `size`, `resolution`, `output_format`, `seed` or `stream`. Do not add a prompt rewriter, provider fallback, extra image model or extra image provider.
- `output_compression` is advertised but intentionally unused.
- Use buffered/non-streaming responses with a 300,000 ms timeout. Do not add fetch retry middleware or automatic SDK retries.
- Require exactly one image with `b64_json`. Treat `media_type` as optional; if present it must agree with decoded bytes. Apply the image size, frame and byte limits from the implementation plan.
- Parse optional usage separately. A malformed optional usage field must not discard an otherwise valid image; record the metering problem and apply the specified cost fallback.
- Persist observed provider cost before or alongside local validation and compositing outcomes.
- Do not expose raw provider error bodies to the browser without sanitization.
- The OpenAI SDK is not used for image calls. It is only the Meta Responses transport; never point it at the direct OpenAI Images API.

## Meta SAM 3.1 contract

### Verified facts

- Model ID: `sam-3.1`.
- Endpoint: `POST https://api.meta.ai/v1/responses`.
- OpenAI SDK base URL: `https://api.meta.ai/v1` (not the full `/responses` path).
- Credential: `META_MODEL_API_KEY`, separate from OpenRouter.
- Timeout: 120,000 ms. Retries: 0.
- Streaming is supported and recommended; non-streaming is allowed by the provider but is not used by this PoC.
- `@meta-sam/parser` latest verified version is `0.1.0`; the project requires `>=0.1.0`. Import from the package root only.
- Verified root exports: `buildObjectPrompt`, `parseImageStream`, `decodeMaskToRaster`, `recordsOfKind`.
- Phase 0 verified the published `0.1.0` package's root `dist/index.d.ts` and parsed the documented SAM fixture with zero diagnostics. `buildObjectPrompt` produced `<0f>1<|point;x=512;y=512;w=1024;h=1024|>` for a single positive point and appended `-<|point;x=100;y=100;w=1024;h=1024|>` for a negative point.
- Parser engine support: Node `^20.17.0 || >=22.9.0`.
- Confidence output (`metadata.include_confidence`) requires parser `>=0.0.13`; the PoC does not request confidence.
- SAM pricing: USD 2.50 per 1,000 images, or USD 0.0025 per image. Streaming and non-streaming requests use the same price.
- SAM is a separate billing account; it is not included in an OpenRouter balance.

### Frozen prompt and output policy

- Build the prompt with `buildObjectPrompt`, not hand-written token grammar.
- Send one user message with `input_text` and an `input_image` data URL containing the canonical 1024 x 1024 PNG.
- Use one to eight positive points and zero to eight negative points, all in canonical pixel coordinates. Object ID is `1`. The UI maps Shift-click to adding a positive point and Alt/Option-click to subtracting a negative point; a plain click replaces the selection.
- Set `stream: true` and `metadata: { mask_encoding: "one_bit" }`. Box/point prompts return `one_bit` masks regardless of the requested encoding; read the wire marker rather than assuming.
- Require a completed stream outcome and zero error-level parser diagnostics. EOF without `response.completed` is not success.
- Preserve the terminal response's request ID and usage through a pass-through event observer if available. Consume the stream once; do not iterate it twice.
- Do not write a custom SAM grammar/base85 parser and do not silently replace SAM with another model. Use the official parser or the documented grammar.
- The decoded mask raster is cropped to the object's bounding box. It is not a full-frame mask.
- Parser box bounds are half-open: `right` and `bottom` are exclusive. Mask dimensions on the wire are height then width. Validate `mask.width === right - left` and `mask.height === bottom - top`.
- Allocate a zero-filled 1024 x 1024 canvas and paste the cropped raster at the parsed box's `left`/`top`. Never resize the crop to fill the canvas and never treat wire `x=0,y=0` as a scene offset.
- Reject out-of-bounds boxes, missing/duplicate object records, inconsistent crop dimensions, non-binary pixels and empty masks.
- Require the positive pixel to be 1 and any negative pixel to be 0 in the full-frame mask. Otherwise report `INVALID_SELECTION`.
- Store the application mask as an immutable full-frame 8-bit grayscale PNG with values 0 or 255. The application mask is binary in meaning; do not assume a 1-bit PNG file.

## Documented examples versus captures

The fixtures under `src/test/fixtures/providers/` are labeled `documented-example` and are not live captures. The SAM fixture is a public 320 x 334 video example with complete base85 payloads; it verifies parsing and cropped-mask geometry but is not valid for the project sample's source-bound fixture mode.

No `captured-live` fixture exists. A future capture must include the canonical source hash, normalization version, exact points, model, capture date and parser records, and must be redacted. Do not fabricate a capture or paste a documented example onto the project sample.

## Discrepancies and notes

- The plan describes the selected values `aspect_ratio: "1:1"`, `quality: "medium"`, `background: "opaque"` and `n: 1`. These are fixed project choices; the endpoints advertise larger value sets/ranges. The chosen values are supported.
- `input_references` supports 0-16. The project uses 0 for generation and 1-3 total images for editing, well inside that range.
- `output_compression` is advertised but unused.
- Native streaming is advertised but disabled by the adapter.
- Dated model aliases exist. Persist observed/resolved IDs rather than assuming the alias is stable.
- The SAM parser's public types confirm `SegmentationMask.width`/`.height` are the raster's own dimensions and `SegmentationMaskRecord.bounds` is the half-open source-pixel box.

## Next step

Phase 1 may proceed with offline mocks. Re-check `src/config/provider-capabilities.json` and `src/config/pricing.json` before any opt-in live test. Missing capabilities must produce `PROVIDER_UNAVAILABLE`, not a substituted model or invented parameter.

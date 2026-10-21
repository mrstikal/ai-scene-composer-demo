# Provider Fixtures

This directory contains only provider-response fixtures used by offline tests.

## Fixture kinds

- `documented-example` — copied or redacted from public provider documentation. It verifies response shape or grammar only. It is not a capture, not proof of live account access, and not evidence that a provider was called. Some documented examples are not decodable because the documentation elides payloads.
- `captured-live` — an authentic, redacted provider capture. A capture must identify its source asset hash, points, model, capture date and request metadata as required by the implementation plan. No captured-live fixtures exist yet.

The `manifest.json` file records every fixture and its kind. `capturedLiveFixtures` must stay empty until an authorized live capture is added.

## Safety rules

- Never store credentials, authorization headers, image data URLs, personal data or unrelated response bodies.
- Never relabel a documented example as a capture.
- Never use a documented example as a source-bound SAM fixture. SAM fixture mode requires an exact canonical source hash and supported points.
- The SAM documented example here is a public video example (320 x 334), not a capture for the 1024 x 1024 project sample.

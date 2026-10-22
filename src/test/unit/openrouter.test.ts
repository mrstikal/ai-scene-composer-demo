import { describe, expect, it } from "vitest";

import {
  buildGenerationPayload,
  callOpenRouterGeneration,
  parseOpenRouterImageResponse,
} from "@/lib/providers/openrouter";
import { createTestImage } from "@/test/helpers/environment";

async function base64Image(width = 1024, height = 1024): Promise<string> {
  return (await createTestImage({ width, height })).toString("base64");
}

function headers(requestId = "req_test"): Headers {
  return new Headers({ "x-request-id": requestId });
}

describe("OpenRouter generation payload", () => {
  it("sends exactly the frozen generation fields and no source/reference/mask", () => {
    const payload = buildGenerationPayload("A calm room.");
    expect(payload).toEqual({
      model: "openai/gpt-image-2.5-flare",
      prompt: "A calm room.",
      aspect_ratio: "1:1",
      quality: "medium",
      background: "opaque",
      n: 1,
      provider: { only: ["openai"], allow_fallbacks: false },
    });
    expect(payload).not.toHaveProperty("input_references");
    expect(payload).not.toHaveProperty("mask");
    expect(payload).not.toHaveProperty("size");
    expect(payload).not.toHaveProperty("output_format");
    expect(payload).not.toHaveProperty("seed");
  });
});

describe("OpenRouter image response parsing", () => {
  it("parses one valid image, usage cost and request ID", async () => {
    const b64 = await base64Image();
    const result = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 123,
      body: {
        data: [{ b64_json: b64, media_type: "image/png" }],
        usage: { cost: 0.04, total_tokens: 4175 },
      },
    });

    expect(result.kind).toBe("image");
    if (result.kind !== "image") throw new Error("Expected image.");
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.mimeType).toBe("image/png");
    expect(result.providerRequestId).toBe("req_test");
    expect(result.observedCostUsdMicros).toBe(40_000);
    expect(result.latencyMs).toBe(123);
    expect(result.usage).toEqual({ cost: 0.04, total_tokens: 4175 });
  });

  it("infers media type when absent and tolerates missing/malformed usage", async () => {
    const b64 = await base64Image();
    const absent = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 1,
      body: { data: [{ b64_json: b64 }] },
    });
    expect(absent.kind).toBe("image");
    expect(absent.observedCostUsdMicros).toBeNull();
    expect(absent.usage).toBeNull();

    const malformed = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 1,
      body: { data: [{ b64_json: b64 }], usage: "not-an-object" },
    });
    expect(malformed.kind).toBe("image");
    expect(malformed.observedCostUsdMicros).toBeNull();
  });

  it("rejects media-type mismatch and non-square/out-of-range images as invalid with raw bytes", async () => {
    const mismatch = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 1,
      body: { data: [{ b64_json: await base64Image(), media_type: "image/jpeg" }] },
    });
    expect(mismatch.kind).toBe("invalid");
    expect(mismatch.kind === "invalid" ? mismatch.bytes : undefined).toBeDefined();

    const nonSquare = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 1,
      body: { data: [{ b64_json: await base64Image(1024, 512) }] },
    });
    expect(nonSquare.kind).toBe("invalid");
    if (nonSquare.kind === "invalid") {
      expect(nonSquare.width).toBe(1024);
      expect(nonSquare.height).toBe(512);
    }

    const tooSmall = await parseOpenRouterImageResponse({
      httpStatus: 200,
      headers: headers(),
      latencyMs: 1,
      body: { data: [{ b64_json: await base64Image(400, 400) }] },
    });
    expect(tooSmall.kind).toBe("invalid");
  });

  it("rejects zero/multiple images and malformed base64", async () => {
    const b64 = await base64Image();
    for (const data of [[], [{ b64_json: b64 }, { b64_json: b64 }], [{ b64_json: "not-base64" }]]) {
      const result = await parseOpenRouterImageResponse({
        httpStatus: 200,
        headers: headers(),
        latencyMs: 1,
        body: { data },
      });
      expect(result.kind).toBe("invalid");
    }
  });

  it("classifies a JSON provider error as a definitive rejection without leaking its body", async () => {
    const result = await parseOpenRouterImageResponse({
      httpStatus: 402,
      headers: headers(),
      latencyMs: 5,
      body: { error: { code: 402, message: "private provider details" } },
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.httpStatus).toBe(402);
      expect(result.message).toBe("OpenRouter rejected the request (HTTP 402).");
      expect(result.message).not.toContain("private provider details");
    }
  });

  it("classifies a non-JSON error response as ambiguous", async () => {
    const result = await parseOpenRouterImageResponse({
      httpStatus: 502,
      headers: headers(),
      latencyMs: 5,
      body: "<html>proxy</html>",
    });
    expect(result.kind).toBe("ambiguous");
  });
});

describe("OpenRouter transport", () => {
  it("posts the exact payload once with Bearer auth and no retry", async () => {
    const b64 = await base64Image();
    let calls = 0;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const result = await callOpenRouterGeneration({
      apiKey: "test-key",
      prompt: "A calm room.",
      fetchImpl: async (url, init) => {
        calls += 1;
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: [{ b64_json: b64, media_type: "image/png" }],
            usage: { cost: 0.04 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-request-id": "req_live" },
          },
        );
      },
    });

    expect(calls).toBe(1);
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/images");
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual(
      buildGenerationPayload("A calm room."),
    );
    expect(result.kind).toBe("image");
  });

  it("returns ambiguous on network failure and a non-JSON success", async () => {
    const network = await callOpenRouterGeneration({
      apiKey: "test-key",
      prompt: "A calm room.",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(network.kind).toBe("ambiguous");

    const nonJson = await callOpenRouterGeneration({
      apiKey: "test-key",
      prompt: "A calm room.",
      fetchImpl: async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(nonJson.kind).toBe("ambiguous");
  });
});

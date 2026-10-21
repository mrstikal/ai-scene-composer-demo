import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MAX_JSON_BYTES,
  MAX_MULTIPART_BYTES,
  MAX_UPLOAD_BYTES,
  parseAssetForm,
  readJsonBody,
  readMultipartForm,
} from "@/lib/http";

function streamedJsonRequest(body: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });

  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded JSON bodies", () => {
  it("parses a valid strict body", async () => {
    const schema = z.object({ title: z.string().min(1) }).strict();
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Scene" }),
    });
    await expect(readJsonBody(request, schema)).resolves.toEqual({ title: "Scene" });
  });

  it("rejects unknown fields and malformed JSON", async () => {
    const schema = z.object({ title: z.string() }).strict();
    await expect(
      readJsonBody(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Scene", extra: true }),
        }),
        schema,
      ),
    ).rejects.toThrow("Invalid request body.");

    await expect(
      readJsonBody(
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        schema,
      ),
    ).rejects.toThrow("Request body is not valid JSON.");
  });

  it("rejects oversized JSON even without Content-Length", async () => {
    const schema = z.object({ text: z.string() }).strict();
    await expect(
      readJsonBody(streamedJsonRequest(JSON.stringify({ text: "x".repeat(MAX_JSON_BYTES) })), schema),
    ).rejects.toThrow("Request body is too large.");
  });
});

describe("bounded multipart bodies", () => {
  it("parses one file and known fields", async () => {
    const form = new FormData();
    form.set("projectId", crypto.randomUUID());
    form.set("role", "base");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" }));

    const request = new Request("http://localhost/api/assets", {
      method: "POST",
      body: form,
    });
    const parsedForm = await readMultipartForm(request);
    const parsed = await parseAssetForm(parsedForm);
    expect(parsed.role).toBe("base");
    expect(parsed.bytes).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects an oversized upload at the multipart and file limits", async () => {
    const oversizedBody = new FormData();
    oversizedBody.set("projectId", crypto.randomUUID());
    oversizedBody.set("role", "base");
    oversizedBody.set(
      "file",
      new File([new Uint8Array(MAX_MULTIPART_BYTES + 1)], "large.png", { type: "image/png" }),
    );
    await expect(
      readMultipartForm(
        new Request("http://localhost/api/assets", { method: "POST", body: oversizedBody }),
      ),
    ).rejects.toThrow("Upload body is too large.");

    const oversizedFile = new FormData();
    oversizedFile.set("projectId", crypto.randomUUID());
    oversizedFile.set("role", "base");
    oversizedFile.set(
      "file",
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "large.png", { type: "image/png" }),
    );
    const parsedForm = await readMultipartForm(
      new Request("http://localhost/api/assets", { method: "POST", body: oversizedFile }),
    );
    await expect(parseAssetForm(parsedForm)).rejects.toThrow("Uploaded file exceeds 10 MiB.");
  });

  it("rejects unknown, duplicate and missing fields", async () => {
    const projectId = crypto.randomUUID();
    const unknown = new FormData();
    unknown.set("projectId", projectId);
    unknown.set("role", "base");
    unknown.set("extra", "no");
    unknown.set("file", new File([new Uint8Array([1])], "test.png", { type: "image/png" }));
    await expect(parseAssetForm(unknown)).rejects.toThrow("Unknown multipart field: extra.");

    const missingFile = new FormData();
    missingFile.set("projectId", projectId);
    missingFile.set("role", "base");
    await expect(parseAssetForm(missingFile)).rejects.toThrow("A file field is required.");

    const badRole = new FormData();
    badRole.set("projectId", projectId);
    badRole.set("role", "mask");
    badRole.set("file", new File([new Uint8Array([1])], "test.png", { type: "image/png" }));
    await expect(parseAssetForm(badRole)).rejects.toThrow(
      "The role field must be base or reference.",
    );
  });
});

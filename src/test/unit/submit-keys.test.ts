import { describe, expect, it } from "vitest";

import { createSubmitKeyStore } from "@/lib/ui/submit-keys";

describe("submit idempotency keys", () => {
  it("reuses a key for the same submit signature", () => {
    const store = createSubmitKeyStore();
    const first = store.keyFor("generate", "project:preset");
    expect(store.keyFor("generate", "project:preset")).toBe(first);
  });

  it("creates a new key for a changed signature or cleared submit", () => {
    const store = createSubmitKeyStore();
    const first = store.keyFor("generate", "project:preset");
    const changed = store.keyFor("generate", "project:custom");
    expect(changed).not.toBe(first);

    store.clear("generate");
    const afterClear = store.keyFor("generate", "project:custom");
    expect(afterClear).not.toBe(changed);
  });

  it("keeps operations independent", () => {
    const store = createSubmitKeyStore();
    const generate = store.keyFor("generate", "same");
    const retry = store.keyFor("retry:run", "same");
    expect(retry).not.toBe(generate);
  });
});

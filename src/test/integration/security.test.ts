import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getHealth } from "@/lib/health/service";
import { getProjectCosts } from "@/lib/costs/service";
import { getRunDetail } from "@/lib/runs/detail";
import { createProject, getProjectSnapshot, importSample } from "@/lib/projects/service";
import { usageEvents } from "@/lib/db/schema";
import { insertRun } from "@/test/helpers/domain";
import { createTestEnvironment, type TestEnvironment } from "@/test/helpers/environment";

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnvironment();
});

afterEach(async () => {
  await testEnv.cleanup();
});

describe("secret and path exposure", () => {
  it("keeps provider keys, storage paths and private payloads out of read DTOs", async () => {
    const openRouterKey = "sk-or-v1-sentinel-openrouter-value";
    const metaKey = "meta-sentinel-value";
    const env = {
      ...testEnv.env,
      openRouterApiKey: openRouterKey,
      metaModelApiKey: metaKey,
    };
    const project = createProject(testEnv.handle.db, env, "Safe Secrets");
    await importSample({
      handle: testEnv.handle,
      env,
      projectId: project.id,
      sampleId: "living-room-v1",
      idempotencyKey: randomUUID(),
    });
    const run = insertRun(testEnv.handle.db, project.id, {
      status: "failed",
      stage: "provider",
      errorMessage: "Provider request failed.",
      inputSnapshotJson: { private: "snapshot-only" },
      providerReceiptJson: {
        kind: "image",
        complete: true,
        rawAssetId: randomUUID(),
        responseMetadata: { private: "receipt-only" },
      },
    });
    testEnv.handle.db
      .insert(usageEvents)
      .values({
        id: randomUUID(),
        projectId: project.id,
        runId: run.id,
        operation: "generate",
        provider: "openrouter",
        model: "openai/gpt-image-2.5-flare",
        executionMode: "mock",
        outcome: "rejected",
        amountUsdMicros: 0,
        costProvenance: "calculated",
        pricingVersion: "2026-10-21-v1",
        pricingSourceSnapshotJson: { private: "pricing-only" },
        usageJson: { private: "usage-only" },
        providerRequestId: "req_safe",
        elapsedMs: 5,
        createdAt: Date.now(),
        settledAt: Date.now(),
      })
      .run();

    const serialized = JSON.stringify({
      health: (await getHealth(testEnv.handle, env)).body,
      project: getProjectSnapshot(testEnv.handle.db, project.id, env),
      costs: getProjectCosts(testEnv.handle.db, project.id),
      detail: getRunDetail(testEnv.handle.db, run.id),
    });

    for (const forbidden of [
      openRouterKey,
      metaKey,
      testEnv.env.assetDir,
      "snapshot-only",
      "receipt-only",
      "pricing-only",
      "usage-only",
      "relativePath",
      "inputSnapshot",
      "providerReceipt",
      "usageJson",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

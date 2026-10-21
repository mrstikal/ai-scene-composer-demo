import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/config/env";
import { createDatabase } from "@/lib/db/client";
import { migrateDatabase } from "@/lib/db/migrate";
import { getHealth } from "@/lib/health/service";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scene-composer-health-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("health readiness", () => {
  it("reports not_ready when the database is not migrated", async () => {
    const root = await tempRoot();
    const handle = createDatabase(join(root, "empty.sqlite"));
    const env = parseEnv(
      {
        AI_MODE: "mock",
        SAM_MODE: "fixture",
        DATABASE_PATH: handle.path,
        ASSET_DIR: join(root, "assets"),
      },
      process.cwd(),
    );

    try {
      const result = await getHealth(handle, env);
      expect(result.status).toBe(503);
      expect(result.body.status).toBe("not_ready");
      expect(result.body.databaseReady).toBe(false);
      expect(result.body.providers.images.available).toBe(true);
      expect(result.body.worker.status).toBe("missing");
    } finally {
      handle.close();
    }
  });

  it("reports not_ready when prepared fixtures are missing", async () => {
    const root = await tempRoot();
    const handle = createDatabase(join(root, "db.sqlite"));
    migrateDatabase(handle.db, join(process.cwd(), "drizzle"));
    const env = parseEnv(
      {
        AI_MODE: "mock",
        SAM_MODE: "fixture",
        DATABASE_PATH: handle.path,
        ASSET_DIR: join(root, "assets"),
      },
      root,
    );

    try {
      const result = await getHealth(handle, env);
      expect(result.status).toBe(503);
      expect(result.body.status).toBe("not_ready");
      expect(result.body.databaseReady).toBe(true);
      expect(result.body.fixtures.sampleProvenance).toBeNull();
    } finally {
      handle.close();
    }
  });
});

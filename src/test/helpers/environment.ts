import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { parseEnv, type AppEnv } from "@/lib/config/env";
import { createDatabase, type DatabaseHandle } from "@/lib/db/client";
import { migrateDatabase } from "@/lib/db/migrate";

export interface TestEnvironment {
  root: string;
  env: AppEnv;
  handle: DatabaseHandle;
  cleanup: () => Promise<void>;
}

export async function createTestEnvironment(): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "scene-composer-test-"));
  const databasePath = join(root, "test.sqlite");
  const assetDir = join(root, "assets");
  const handle = createDatabase(databasePath);
  migrateDatabase(handle.db, join(process.cwd(), "drizzle"));

  const env = parseEnv(
    {
      ...process.env,
      AI_MODE: "mock",
      SAM_MODE: "fixture",
      RUN_LIVE_AI_TESTS: "0",
      DATABASE_PATH: databasePath,
      ASSET_DIR: assetDir,
      PROJECT_BUDGET_USD: "5",
      IMAGE_RESERVATION_USD: "0.25",
      OPENROUTER_API_KEY: "",
      META_MODEL_API_KEY: "",
    },
    process.cwd(),
  );

  return {
    root,
    env,
    handle,
    cleanup: async () => {
      handle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createTestImage(input: {
  width: number;
  height: number;
  format?: "png" | "jpeg" | "webp";
  background?: { r: number; g: number; b: number; alpha?: number };
  channels?: 3 | 4;
  orientation?: number;
}): Promise<Buffer> {
  const format = input.format ?? "png";
  const channels = input.channels ?? 3;
  const background = input.background ?? { r: 120, g: 140, b: 160 };

  let pipeline = sharp({
    create: {
      width: input.width,
      height: input.height,
      channels,
      background,
    },
  });

  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality: 92 });
    if (input.orientation !== undefined) {
      pipeline = pipeline.withMetadata({ orientation: input.orientation });
    }
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality: 92 });
  } else {
    pipeline = pipeline.png();
  }

  return pipeline.toBuffer();
}

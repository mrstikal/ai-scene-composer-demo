import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { AppError } from "../errors";

const fixtureSchema = z
  .object({
    fixtureId: z.enum(["living-room-v1", "reference-sofa-v1"]),
    selectedPath: z.string().min(1),
    provenance: z.enum(["licensed_photo", "synthetic"]),
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    normalizationVersion: z.literal("normalization-v1"),
    licenseRecord: z.string().nullable(),
    generator: z.string().optional(),
    generatorVersion: z.string().optional(),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtures: z.array(fixtureSchema).length(2),
    licensedPhotosReady: z.boolean(),
    samFixtureReady: z.boolean(),
  })
  .strict();

export type FixtureManifest = z.infer<typeof manifestSchema>;
export type FixtureEntry = z.infer<typeof fixtureSchema>;

export function fixturesRoot(repoRoot: string): string {
  return join(repoRoot, "src/test/fixtures");
}

export function fixtureManifestPath(repoRoot: string): string {
  return join(fixturesRoot(repoRoot), "manifest.json");
}

export function readFixtureManifest(repoRoot: string): FixtureManifest {
  const path = fixtureManifestPath(repoRoot);
  if (!existsSync(path)) {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", "Fixture manifest is missing. Run npm run fixtures:prepare.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", "Fixture manifest is invalid. Run npm run fixtures:prepare.");
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", "Fixture manifest is invalid. Run npm run fixtures:prepare.");
  }
  return parsed.data;
}

export function tryReadFixtureManifest(repoRoot: string): FixtureManifest | null {
  try {
    return readFixtureManifest(repoRoot);
  } catch {
    return null;
  }
}

export function getFixture(manifest: FixtureManifest, fixtureId: FixtureEntry["fixtureId"]): FixtureEntry {
  const fixture = manifest.fixtures.find((entry) => entry.fixtureId === fixtureId);
  if (fixture === undefined) {
    throw new AppError(503, "FIXTURES_NOT_PREPARED", `Fixture ${fixtureId} is missing.`);
  }
  return fixture;
}

export function resolveFixtureRelativePath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== absolute) {
    throw new AppError(500, "CONFIG_INVALID", "Fixture path escapes the fixtures directory.");
  }
  return absolute;
}

export function fixtureAssetsReady(manifest: FixtureManifest, root: string): boolean {
  return manifest.fixtures.every((fixture) => existsSync(resolveFixtureRelativePath(root, fixture.selectedPath)));
}

export function samFixtureReady(repoRoot: string): boolean {
  const root = join(fixturesRoot(repoRoot), "sam");
  return (
    existsSync(join(root, "living-room-v1.positive.json")) &&
    existsSync(join(root, "living-room-v1.negative.json"))
  );
}

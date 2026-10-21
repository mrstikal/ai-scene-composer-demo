import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import sharp from "sharp";

import { sha256Hex } from "../assets/store";
import type { FixtureEntry, FixtureManifest } from "../config/fixtures";
import { inspectImage, normalizeBase, normalizeReference, type NormalizedImage } from "../images/normalize";
import { AppError } from "../errors";

export const SYNTHETIC_GENERATOR = "prepare-fixtures";
export const SYNTHETIC_GENERATOR_VERSION = "synthetic-v1";

function roomSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#E8E2D9"/>
  <rect y="700" width="1024" height="324" fill="#C9B79C"/>
  <rect x="60" y="120" width="220" height="260" fill="#BFD8E8" stroke="#6F6257" stroke-width="12"/>
  <rect x="164" y="120" width="10" height="260" fill="#6F6257"/>
  <rect x="60" y="244" width="220" height="10" fill="#6F6257"/>
  <rect x="300" y="420" width="430" height="170" rx="18" fill="#C8B39A"/>
  <rect x="300" y="520" width="430" height="70" rx="18" fill="#B8A087"/>
  <rect x="330" y="455" width="180" height="70" rx="16" fill="#D8C7B2"/>
  <rect x="520" y="455" width="180" height="70" rx="16" fill="#D8C7B2"/>
  <rect x="310" y="585" width="18" height="45" fill="#6B4F3A"/>
  <rect x="702" y="585" width="18" height="45" fill="#6B4F3A"/>
  <rect x="90" y="500" width="150" height="140" rx="16" fill="#9BAE9C"/>
  <rect x="90" y="585" width="150" height="55" rx="16" fill="#869C88"/>
  <rect x="110" y="625" width="16" height="40" fill="#4E4A45"/>
  <rect x="204" y="625" width="16" height="40" fill="#4E4A45"/>
  <rect x="430" y="220" width="180" height="120" fill="#6B4F3A"/>
  <rect x="445" y="235" width="150" height="90" fill="#D9C9B8"/>
  <rect x="500" y="255" width="40" height="40" fill="#A9B8C4"/>
  <rect x="850" y="260" width="10" height="290" fill="#4E4A45"/>
  <polygon points="810,260 900,260 880,180 830,180" fill="#D6C48E"/>
  <rect x="820" y="545" width="70" height="12" rx="6" fill="#4E4A45"/>
  <rect x="350" y="700" width="330" height="100" rx="12" fill="#8C6B4F"/>
  <rect x="365" y="725" width="300" height="12" fill="#A98463"/>
  <rect x="385" y="790" width="20" height="55" fill="#5B4635"/>
  <rect x="625" y="790" width="20" height="55" fill="#5B4635"/>
</svg>`;
}

function sofaSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#F0F0F0"/>
  <rect x="150" y="350" width="724" height="330" rx="40" fill="#B58B6A"/>
  <rect x="150" y="520" width="724" height="160" rx="32" fill="#A47757"/>
  <rect x="210" y="410" width="280" height="130" rx="28" fill="#C9A183"/>
  <rect x="534" y="410" width="280" height="130" rx="28" fill="#C9A183"/>
  <rect x="210" y="545" width="280" height="90" rx="20" fill="#BE9476"/>
  <rect x="534" y="545" width="280" height="90" rx="20" fill="#BE9476"/>
  <rect x="170" y="470" width="70" height="190" rx="24" fill="#8F6549"/>
  <rect x="784" y="470" width="70" height="190" rx="24" fill="#8F6549"/>
  <rect x="220" y="680" width="24" height="70" fill="#5B4635"/>
  <rect x="780" y="680" width="24" height="70" fill="#5B4635"/>
</svg>`;
}

async function renderSynthetic(
  fixturesRoot: string,
  fixtureId: "living-room-v1" | "reference-sofa-v1",
  svg: string,
): Promise<Buffer> {
  const bytes = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  const path = join(fixturesRoot, "synthetic", `${fixtureId}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

function findPhoto(fixturesRoot: string, fixtureId: string): string | null {
  const candidates = ["jpg", "png"]
    .map((extension) => join(fixturesRoot, "photos", `${fixtureId}.${extension}`))
    .filter((path) => existsSync(path));

  if (candidates.length > 1) {
    throw new AppError(
      409,
      "FIXTURE_AMBIGUOUS",
      `Both .jpg and .png exist for ${fixtureId}. Keep exactly one photograph.`,
    );
  }
  return candidates[0] ?? null;
}

async function requireLicenseRecord(fixturesRoot: string, fixtureId: string): Promise<string> {
  const relative = `licenses/${fixtureId}.md`;
  const absolute = join(fixturesRoot, relative);
  if (!existsSync(absolute)) {
    throw new AppError(
      409,
      "FIXTURE_LICENSE_MISSING",
      `Photograph ${fixtureId} exists without ${relative}.`,
    );
  }

  const content = (await readFile(absolute, "utf8")).trim();
  if (content.length < 20) {
    throw new AppError(
      409,
      "FIXTURE_LICENSE_MISSING",
      `License record ${relative} is empty or incomplete.`,
    );
  }
  return relative;
}

async function prepareEntry(input: {
  fixturesRoot: string;
  fixtureId: "living-room-v1" | "reference-sofa-v1";
  syntheticBytes: Buffer;
  normalize: (bytes: Buffer) => Promise<NormalizedImage>;
}): Promise<FixtureEntry> {
  const photoPath = findPhoto(input.fixturesRoot, input.fixtureId);

  if (photoPath !== null) {
    const licenseRecord = await requireLicenseRecord(input.fixturesRoot, input.fixtureId);
    const bytes = await readFile(photoPath);
    const inspected = await inspectImage(bytes);

    if (input.fixtureId === "living-room-v1") {
      if (inspected.width !== inspected.height) {
        throw new AppError(422, "INVALID_IMAGE", "living-room-v1 photograph must be square.");
      }
      if (inspected.width < 1024) {
        throw new AppError(
          422,
          "INVALID_IMAGE",
          "living-room-v1 photograph must be at least 1024 x 1024 pixels.",
        );
      }
    } else if (Math.max(inspected.width, inspected.height) < 1024) {
      throw new AppError(
        422,
        "INVALID_IMAGE",
        "reference-sofa-v1 photograph must be at least 1024 pixels on its longest side.",
      );
    }

    const normalized = await input.normalize(bytes);
    return {
      fixtureId: input.fixtureId,
      selectedPath: `photos/${basename(photoPath)}`,
      provenance: "licensed_photo",
      originalSha256: sha256Hex(bytes),
      normalizedSha256: normalized.sha256,
      normalizationVersion: "normalization-v1",
      licenseRecord,
    };
  }

  const normalized = await input.normalize(input.syntheticBytes);
  return {
    fixtureId: input.fixtureId,
    selectedPath: `synthetic/${input.fixtureId}.png`,
    provenance: "synthetic",
    originalSha256: sha256Hex(input.syntheticBytes),
    normalizedSha256: normalized.sha256,
    normalizationVersion: "normalization-v1",
    licenseRecord: null,
    generator: SYNTHETIC_GENERATOR,
    generatorVersion: SYNTHETIC_GENERATOR_VERSION,
  };
}

export async function prepareFixtures(fixturesRoot: string): Promise<FixtureManifest> {
  await mkdir(join(fixturesRoot, "synthetic"), { recursive: true });
  await mkdir(join(fixturesRoot, "photos"), { recursive: true });
  await mkdir(join(fixturesRoot, "licenses"), { recursive: true });
  await mkdir(join(fixturesRoot, "sam"), { recursive: true });

  const roomBytes = await renderSynthetic(fixturesRoot, "living-room-v1", roomSvg());
  const sofaBytes = await renderSynthetic(fixturesRoot, "reference-sofa-v1", sofaSvg());

  const livingRoom = await prepareEntry({
    fixturesRoot,
    fixtureId: "living-room-v1",
    syntheticBytes: roomBytes,
    normalize: normalizeBase,
  });
  const referenceSofa = await prepareEntry({
    fixturesRoot,
    fixtureId: "reference-sofa-v1",
    syntheticBytes: sofaBytes,
    normalize: normalizeReference,
  });

  const manifest: FixtureManifest = {
    schemaVersion: 1,
    fixtures: [livingRoom, referenceSofa],
    licensedPhotosReady: [livingRoom, referenceSofa].every(
      (fixture) => fixture.provenance === "licensed_photo" && fixture.licenseRecord !== null,
    ),
    samFixtureReady:
      existsSync(join(fixturesRoot, "sam", "living-room-v1.positive.json")) &&
      existsSync(join(fixturesRoot, "sam", "living-room-v1.negative.json")),
  };

  const manifestPath = join(fixturesRoot, "manifest.json");
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, serialized);
  return manifest;
}

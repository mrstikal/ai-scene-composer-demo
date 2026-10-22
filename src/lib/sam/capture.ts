import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../assets/store";
import {
  SAM_MODEL,
  samCaptureSchema,
  type Point,
  type SamCapture,
  type SamMaskRecord,
} from "../contracts/domain";
import { fixturesRoot, resolveFixtureRelativePath } from "../config/fixtures";
import { buildFullFrameMaskFromRecords, type FullFrameMask } from "../images/mask-pipeline";

export const SAM_FIXTURE_DIRECTORY = "sam";
export const SAM_POSITIVE_CAPTURE = "living-room-v1.positive.json";
export const SAM_NEGATIVE_CAPTURE = "living-room-v1.negative.json";

export function samCaptureFileName(negativePoints: readonly Point[]): string {
  return negativePoints.length === 0 ? SAM_POSITIVE_CAPTURE : SAM_NEGATIVE_CAPTURE;
}

export function samCaptureRelativePath(negativePoints: readonly Point[]): string {
  return `${SAM_FIXTURE_DIRECTORY}/${samCaptureFileName(negativePoints)}`;
}

function samePoints(left: readonly Point[], right: readonly Point[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((point, index) => point.x === right[index]?.x && point.y === right[index]?.y);
}

export function validateSamCapture(
  capture: SamCapture,
  request: {
    sourceSha256: string;
    width: number;
    height: number;
    positivePoints: readonly Point[];
    negativePoints: readonly Point[];
    model?: string;
  },
): string | null {
  return validateSamCaptureDetails(capture, request).reason;
}

function validateSamCaptureDetails(
  capture: SamCapture,
  request: {
    sourceSha256: string;
    width: number;
    height: number;
    positivePoints: readonly Point[];
    negativePoints: readonly Point[];
    model?: string;
  },
): { reason: string | null; fullMask: FullFrameMask | null } {
  if (capture.sourceCanonicalSha256 !== request.sourceSha256) {
    return { reason: "SAM capture is bound to a different source image.", fullMask: null };
  }
  if (capture.width !== request.width || capture.height !== request.height) {
    return { reason: "SAM capture dimensions do not match the source image.", fullMask: null };
  }
  if (capture.model !== (request.model ?? SAM_MODEL)) {
    return { reason: "SAM capture model does not match the configured model.", fullMask: null };
  }
  if (!samePoints(capture.positivePoints, request.positivePoints)) {
    return { reason: "SAM capture does not match the positive points.", fullMask: null };
  }
  if (!samePoints(capture.negativePoints, request.negativePoints)) {
    return { reason: "SAM capture does not match the negative points.", fullMask: null };
  }

  try {
    const fullMask = buildFullFrameMaskFromRecords({
      records: capture.records,
      frameWidth: capture.width,
      frameHeight: capture.height,
      positivePoints: capture.positivePoints,
      negativePoints: capture.negativePoints,
    });
    return { reason: null, fullMask };
  } catch {
    return { reason: "SAM capture records are not a valid completed segmentation.", fullMask: null };
  }
}

export type SamCaptureLookup =
  | {
      status: "ready";
      capture: SamCapture;
      relativePath: string;
      absolutePath: string;
      sha256: string;
      fullMask: FullFrameMask;
    }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export function loadSamCapture(input: {
  repoRoot: string;
  sourceSha256: string;
  width: number;
  height: number;
  positivePoints: readonly Point[];
  negativePoints: readonly Point[];
}): SamCaptureLookup {
  const relativePath = samCaptureRelativePath(input.negativePoints);
  const root = fixturesRoot(input.repoRoot);
  let absolutePath: string;
  try {
    absolutePath = resolveFixtureRelativePath(root, relativePath);
  } catch {
    return { status: "invalid", reason: "SAM capture path is invalid." };
  }

  if (!existsSync(/* turbopackIgnore: true */ absolutePath)) return { status: "missing" };

  let raw: unknown;
  let fileBytes: Buffer;
  try {
    fileBytes = readFileSync(/* turbopackIgnore: true */ absolutePath);
    raw = JSON.parse(fileBytes.toString("utf8"));
  } catch {
    return { status: "invalid", reason: "SAM capture is not valid JSON." };
  }

  const parsed = samCaptureSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", reason: "SAM capture does not match the captured-live schema." };
  }

  const validation = validateSamCaptureDetails(parsed.data, input);
  if (validation.reason !== null || validation.fullMask === null) {
    return { status: "invalid", reason: validation.reason ?? "SAM capture is invalid." };
  }

  return {
    status: "ready",
    capture: parsed.data,
    relativePath,
    absolutePath,
    sha256: sha256Hex(fileBytes),
    fullMask: validation.fullMask,
  };
}

export function replaySamCapture(
  capture: SamCapture,
  fullMask?: FullFrameMask,
): {
  records: SamMaskRecord[];
  fullMask: FullFrameMask;
} {
  return {
    records: capture.records,
    fullMask:
      fullMask ??
      buildFullFrameMaskFromRecords({
        records: capture.records,
        frameWidth: capture.width,
        frameHeight: capture.height,
        positivePoints: capture.positivePoints,
        negativePoints: capture.negativePoints,
      }),
  };
}

export function samFixturePaths(repoRoot: string): {
  positive: string;
  negative: string;
} {
  return samFixturePathsAtRoot(fixturesRoot(repoRoot));
}

function samFixturePathsAtRoot(root: string): {
  positive: string;
  negative: string;
} {
  const samRoot = join(root, SAM_FIXTURE_DIRECTORY);
  return {
    positive: join(samRoot, SAM_POSITIVE_CAPTURE),
    negative: join(samRoot, SAM_NEGATIVE_CAPTURE),
  };
}

export interface SamFixtureStatus {
  ready: boolean;
  reason: string | null;
}

let cachedFixtureStatus: { key: string; status: SamFixtureStatus } | null = null;

function fileSignature(path: string): string {
  try {
    const stats = statSync(/* turbopackIgnore: true */ path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

export function samFixtureStatus(
  repoRoot: string,
  sampleCanonicalSha256?: string,
): SamFixtureStatus {
  return samFixtureStatusAtRoot(fixturesRoot(repoRoot), sampleCanonicalSha256);
}

export function samFixtureStatusAtRoot(
  fixtureRoot: string,
  sampleCanonicalSha256?: string,
): SamFixtureStatus {
  const paths = samFixturePathsAtRoot(fixtureRoot);
  const cacheKey = [
    fixtureRoot,
    sampleCanonicalSha256 ?? "",
    fileSignature(paths.positive),
    fileSignature(paths.negative),
  ].join("|");
  if (cachedFixtureStatus?.key === cacheKey) return cachedFixtureStatus.status;

  const status = computeSamFixtureStatus(paths, sampleCanonicalSha256);
  cachedFixtureStatus = { key: cacheKey, status };
  return status;
}

function computeSamFixtureStatus(
  paths: { positive: string; negative: string },
  sampleCanonicalSha256?: string,
): SamFixtureStatus {
  for (const [name, path] of [
    [SAM_POSITIVE_CAPTURE, paths.positive],
    [SAM_NEGATIVE_CAPTURE, paths.negative],
  ] as const) {
    if (!existsSync(/* turbopackIgnore: true */ path)) {
      return { ready: false, reason: `${name} is missing.` };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
    } catch {
      return { ready: false, reason: `${name} is not valid JSON.` };
    }

    const parsed = samCaptureSchema.safeParse(raw);
    if (!parsed.success) {
      return { ready: false, reason: `${name} does not match the captured-live schema.` };
    }
    if (
      sampleCanonicalSha256 !== undefined &&
      parsed.data.sourceCanonicalSha256 !== sampleCanonicalSha256
    ) {
      return { ready: false, reason: `${name} is bound to a different source image.` };
    }

    const validation = validateSamCaptureDetails(parsed.data, {
      sourceSha256: parsed.data.sourceCanonicalSha256,
      width: parsed.data.width,
      height: parsed.data.height,
      positivePoints: parsed.data.positivePoints,
      negativePoints: parsed.data.negativePoints,
    });
    if (validation.reason !== null) {
      return { ready: false, reason: `${name}: ${validation.reason}` };
    }
  }

  return { ready: true, reason: null };
}

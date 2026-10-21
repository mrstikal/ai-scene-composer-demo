import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppError } from "../errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AssetMimeType = "image/png" | "image/jpeg" | "image/webp";

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assetExtensionForMime(mimeType: AssetMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

export function mimeTypeForFormat(format: string | undefined): AssetMimeType | null {
  if (format === "png") return "image/png";
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return null;
}

export function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(500, "CONFIG_INVALID", `${label} is not a valid UUID.`);
  }
  return value;
}

export function resolveAssetPath(assetDir: string, relativePath: string): string {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new AppError(500, "CONFIG_INVALID", "Asset path must be relative.");
  }

  const root = resolve(assetDir);
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(root, rel) !== absolute) {
    throw new AppError(500, "CONFIG_INVALID", "Asset path escapes the asset directory.");
  }
  return absolute;
}

export interface WrittenAsset {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
}

export async function writeAssetBytes(input: {
  assetDir: string;
  projectId: string;
  assetId: string;
  mimeType: AssetMimeType;
  bytes: Buffer;
}): Promise<WrittenAsset> {
  const projectId = assertUuid(input.projectId, "projectId");
  const assetId = assertUuid(input.assetId, "assetId");
  const extension = assetExtensionForMime(input.mimeType);
  const relativePath = join(projectId, `${assetId}.${extension}`);
  const absolutePath = resolveAssetPath(input.assetDir, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.bytes, { flag: "wx" });

  return {
    relativePath,
    absolutePath,
    sha256: sha256Hex(input.bytes),
    bytes: input.bytes.length,
  };
}

export async function readAssetBytes(assetDir: string, relativePath: string): Promise<Buffer> {
  const absolutePath = resolveAssetPath(assetDir, relativePath);
  try {
    return await readFile(absolutePath);
  } catch {
    throw new AppError(404, "NOT_FOUND", "Asset file was not found.");
  }
}

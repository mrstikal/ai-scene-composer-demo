import { getEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/db/client";
import {
  jsonResponse,
  parseAssetForm,
  readMultipartForm,
  requireIdempotencyKey,
  route,
} from "@/lib/http";
import { importUploadedAsset } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const form = await readMultipartForm(request);
    const parsed = await parseAssetForm(form);
    const env = getEnv();
    const handle = getDatabase();
    const stored = await importUploadedAsset({
      handle,
      env,
      projectId: parsed.projectId,
      role: parsed.role,
      bytes: parsed.bytes,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  }, request);
}

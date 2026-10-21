import { readAssetBytes } from "@/lib/assets/store";
import { getEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/db/client";
import { errorResponse } from "@/lib/http";
import { getAssetOrThrow } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const env = getEnv();
    const handle = getDatabase();
    const asset = getAssetOrThrow(handle.db, id);
    const bytes = await readAssetBytes(env.assetDir, asset.relativePath);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600, immutable",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

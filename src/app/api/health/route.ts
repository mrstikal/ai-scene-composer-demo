import { getEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/db/client";
import { getHealth, notReadyHealth } from "@/lib/health/service";
import { assertSameOrigin, errorResponse, jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    return errorResponse(error);
  }
  try {
    const env = getEnv();
    const handle = getDatabase();
    const { status, body } = await getHealth(handle, env);
    return jsonResponse(body, status);
  } catch {
    return jsonResponse(notReadyHealth(), 503);
  }
}

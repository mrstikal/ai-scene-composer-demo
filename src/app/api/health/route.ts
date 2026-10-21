import { getEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/db/client";
import { getHealth, notReadyHealth } from "@/lib/health/service";
import { jsonResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const env = getEnv();
    const handle = getDatabase();
    const { status, body } = await getHealth(handle, env);
    return jsonResponse(body, status);
  } catch {
    return jsonResponse(notReadyHealth(), 503);
  }
}

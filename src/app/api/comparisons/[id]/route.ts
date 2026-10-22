import { getEnv } from "@/lib/config/env";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, route } from "@/lib/http";
import { getComparisonDetail } from "@/lib/comparisons/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const handle = getDatabase();
    return jsonResponse(getComparisonDetail(handle.db, id, getEnv()));
  });
}

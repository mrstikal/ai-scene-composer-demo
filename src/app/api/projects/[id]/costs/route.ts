import { getDatabase } from "@/lib/db/client";
import { jsonResponse, route } from "@/lib/http";
import { getProjectCosts } from "@/lib/costs/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const handle = getDatabase();
    return jsonResponse(getProjectCosts(handle.db, id));
  });
}

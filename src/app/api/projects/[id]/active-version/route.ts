import { activeVersionSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, route } from "@/lib/http";
import { setActiveVersion } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const input = await readJsonBody(request, activeVersionSchema);
    const { id } = await context.params;
    const handle = getDatabase();
    const activeVersionId = setActiveVersion(handle.db, id, input.versionId);
    return jsonResponse({ activeVersionId });
  });
}

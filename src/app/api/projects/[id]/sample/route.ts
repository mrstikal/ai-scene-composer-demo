import { getEnv } from "@/lib/config/env";
import { sampleImportSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";
import { importSample } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, sampleImportSchema);
    const { id } = await context.params;
    const env = getEnv();
    const handle = getDatabase();
    const stored = await importSample({
      handle,
      env,
      projectId: id,
      sampleId: input.sampleId,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  });
}

import { getEnv } from "@/lib/config/env";
import { generationRequestSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";
import { enqueueGeneration } from "@/lib/generations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, generationRequestSchema);
    const env = getEnv();
    const handle = getDatabase();
    const stored = await enqueueGeneration({
      handle,
      env,
      projectId: input.projectId,
      generationInput: input.input,
      costConsent: input.costConsent,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  }, request);
}

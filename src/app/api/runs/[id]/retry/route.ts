import { getEnv } from "@/lib/config/env";
import { retryRequestSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";
import { enqueueRetry } from "@/lib/runs/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, retryRequestSchema);
    const { id } = await context.params;
    const env = getEnv();
    const handle = getDatabase();
    const stored = await enqueueRetry({
      handle,
      env,
      runId: id,
      costConsent: input.costConsent,
      acknowledgePossibleDuplicateCharge: input.acknowledgePossibleDuplicateCharge,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  }, request);
}

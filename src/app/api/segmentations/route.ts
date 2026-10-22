import { getEnv } from "@/lib/config/env";
import { segmentationRequestSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";
import { enqueueSegmentation } from "@/lib/segmentations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, segmentationRequestSchema);
    const env = getEnv();
    const handle = getDatabase();
    const stored = await enqueueSegmentation({
      handle,
      env,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      positivePoints: input.positivePoints,
      negativePoints: input.negativePoints,
      costConsent: input.costConsent,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  });
}

import { getEnv } from "@/lib/config/env";
import { comparisonRequestSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { enqueueComparison } from "@/lib/comparisons/service";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, comparisonRequestSchema);
    const env = getEnv();
    const handle = getDatabase();
    const stored = await enqueueComparison({
      handle,
      env,
      projectId: input.projectId,
      parentVersionId: input.parentVersionId,
      selectionId: input.selectionId,
      paddingPx: input.paddingPx,
      targetLabel: input.targetLabel,
      instruction: input.instruction,
      referenceAssetIds: input.referenceAssetIds,
      costConsent: input.costConsent,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  }, request);
}

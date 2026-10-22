import { getEnv } from "@/lib/config/env";
import { editRequestSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { enqueueEdit } from "@/lib/edits/service";
import { jsonResponse, readJsonBody, requireIdempotencyKey, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await readJsonBody(request, editRequestSchema);
    const env = getEnv();
    const handle = getDatabase();
    const stored = await enqueueEdit({
      handle,
      env,
      projectId: input.projectId,
      parentVersionId: input.parentVersionId,
      scope: input.scope,
      selectionId: input.selectionId,
      paddingPx: input.paddingPx,
      targetLabel: input.targetLabel,
      instruction: input.instruction,
      referenceAssetIds: input.referenceAssetIds,
      model: input.model,
      costConsent: input.costConsent,
      idempotencyKey,
    });
    return jsonResponse(stored.body, stored.status);
  }, request);
}

import { evaluationSchema } from "@/lib/contracts/domain";
import { getDatabase } from "@/lib/db/client";
import { saveRunEvaluation } from "@/lib/evaluation/service";
import { jsonResponse, readJsonBody, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const { id } = await context.params;
    const evaluation = await readJsonBody(request, evaluationSchema);
    const handle = getDatabase();
    const saved = saveRunEvaluation(handle.db, id, evaluation);
    return jsonResponse({ evaluation: saved });
  });
}

import { getEnv } from "@/lib/config/env";
import { createProjectSchema } from "@/lib/contracts/api";
import { getDatabase } from "@/lib/db/client";
import { jsonResponse, readJsonBody, route } from "@/lib/http";
import { createProject, listProjects } from "@/lib/projects/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    const handle = getDatabase();
    return jsonResponse(listProjects(handle.db));
  }, request);
}

export async function POST(request: Request): Promise<Response> {
  return route(async () => {
    const input = await readJsonBody(request, createProjectSchema);
    const env = getEnv();
    const handle = getDatabase();
    const project = createProject(handle.db, env, input.title);
    return jsonResponse({ projectId: project.id }, 201);
  }, request);
}

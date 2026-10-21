"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

import type {
  AssetUploadResponse,
  HealthResponse,
  ProjectListDto,
  ProjectSnapshotDto,
  SampleImportResponse,
} from "@/lib/contracts/api";

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }
  return body as T;
}

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health", { cache: "no-store" });
  return (await response.json()) as HealthResponse;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function versionProvenance(version: ProjectSnapshotDto["versions"][number]): string | null {
  const metadata = version.sourceMetadata as { provenance?: unknown } | null;
  if (metadata?.provenance === "synthetic") return "Synthetic Sample";
  if (metadata?.provenance === "licensed_photo") return "Licensed photo";
  return null;
}

export function AppShell() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<ProjectListDto["projects"]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProjectSnapshotDto | null>(null);
  const [title, setTitle] = useState("");
  const [tab, setTab] = useState<"sample" | "upload">("sample");
  const [role, setRole] = useState<"base" | "reference">("base");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProject = useCallback(async (id: string) => {
    const next = await apiRequest<ProjectSnapshotDto>(`/api/projects/${id}`);
    setProjectId(id);
    setSnapshot(next);
    window.history.replaceState(null, "", `/?project=${id}`);
  }, []);

  const refreshProjects = useCallback(async (): Promise<ProjectListDto["projects"]> => {
    const result = await apiRequest<ProjectListDto>("/api/projects");
    setProjects(result.projects);
    return result.projects;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadInitial(): Promise<void> {
      try {
        const [nextHealth, nextProjects] = await Promise.all([
          fetchHealth(),
          apiRequest<ProjectListDto>("/api/projects"),
        ]);
        if (cancelled) return;

        setHealth(nextHealth);
        setProjects(nextProjects.projects);

        const requested = new URLSearchParams(window.location.search).get("project");
        const selected =
          (requested !== null && nextProjects.projects.some((project) => project.id === requested)
            ? requested
            : null) ?? nextProjects.projects[0]?.id ?? null;

        if (selected === null) {
          setProjectId(null);
          setSnapshot(null);
          return;
        }

        const next = await apiRequest<ProjectSnapshotDto>(`/api/projects/${selected}`);
        if (cancelled) return;
        setProjectId(selected);
        setSnapshot(next);
        window.history.replaceState(null, "", `/?project=${selected}`);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Initial load failed.");
        }
      }
    }

    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeVersion =
    snapshot?.versions.find((version) => version.id === snapshot.project.activeVersionId) ?? null;
  const activeProvenance = activeVersion === null ? null : versionProvenance(activeVersion);

  async function handleCreateProject(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = title.trim().length > 0 ? { title: title.trim() } : {};
      const result = await apiRequest<{ projectId: string }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTitle("");
      await refreshProjects();
      await loadProject(result.projectId);
      setNotice("Project created. Choose a sample or upload a base image.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectProject(nextId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await loadProject(nextId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project load failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSample(): Promise<void> {
    if (projectId === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest<SampleImportResponse>(`/api/projects/${projectId}/sample`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ sampleId: "living-room-v1" }),
      });
      await loadProject(projectId);
      setNotice("Bundled sample imported as the root scene.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sample import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(): Promise<void> {
    if (projectId === null || file === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("role", effectiveRole);
      form.set("file", file);
      const result = await apiRequest<AssetUploadResponse>("/api/assets", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: form,
      });
      setFile(null);
      await loadProject(projectId);
      setNotice(
        result.rootVersionId === null
          ? "Reference image uploaded."
          : "Base image uploaded as the root scene.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectVersion(versionId: string): Promise<void> {
    if (projectId === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/projects/${projectId}/active-version`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      await loadProject(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Version selection failed.");
    } finally {
      setBusy(false);
    }
  }

  const hasRoot = snapshot?.project.rootVersionId !== null && snapshot?.project.rootVersionId !== undefined;
  const canUploadBase = projectId !== null && !hasRoot;
  const effectiveRole = hasRoot ? "reference" : role;

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-300 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">AI Scene Composer</h1>
            <p className="text-sm text-stone-600">Local PoC foundation: upload, sample and version tree</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-stone-900 px-3 py-1 text-xs font-medium text-white">
              {health?.modes.ai === "live" ? "Live mode" : "Mock mode — no provider calls"}
            </span>
            <span className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700">
              SAM: {health?.modes.sam ?? "fixture"}
            </span>
            <span className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700">
              Worker: {health?.worker.status ?? "unknown"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="space-y-4">
          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Project</h2>
            <div className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-stone-600" htmlFor="project-select">
                Existing project
              </label>
              <select
                id="project-select"
                className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                value={projectId ?? ""}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next.length > 0) void handleSelectProject(next);
                }}
                disabled={busy || projects.length === 0}
              >
                <option value="">{projects.length === 0 ? "No projects yet" : "Select a project"}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title} ({shortId(project.id)})
                  </option>
                ))}
              </select>
              <label className="block text-xs font-medium text-stone-600" htmlFor="project-title">
                New project title
              </label>
              <input
                id="project-title"
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Untitled Scene"
              />
              <button
                type="button"
                className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void handleCreateProject()}
                disabled={busy}
              >
                New Scene
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Source</h2>
            {projectId === null ? (
              <p className="mt-2 text-sm text-stone-600">Create or select a project first.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {!hasRoot ? (
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
                    <button
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-sm ${tab === "sample" ? "bg-white shadow-sm" : "text-stone-600"}`}
                      onClick={() => setTab("sample")}
                    >
                      Sample
                    </button>
                    <button
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-sm ${tab === "upload" ? "bg-white shadow-sm" : "text-stone-600"}`}
                      onClick={() => setTab("upload")}
                    >
                      Upload
                    </button>
                  </div>
                ) : null}

                {!hasRoot && tab === "sample" ? (
                  <div className="space-y-2">
                    <p className="text-sm text-stone-600">
                      {health?.fixtures.sampleProvenance === "licensed_photo"
                        ? "Use the owner-supplied licensed sample."
                        : "Use the labeled synthetic sample."}
                    </p>
                    <button
                      type="button"
                      className="w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium disabled:opacity-50"
                      onClick={() => void handleSample()}
                      disabled={busy}
                    >
                      Use Bundled Sample
                    </button>
                  </div>
                ) : null}

                {(hasRoot || tab === "upload") ? (
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-stone-600" htmlFor="asset-role">
                      Upload role
                    </label>
                    <select
                      id="asset-role"
                      className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                      value={effectiveRole}
                      onChange={(event) => setRole(event.target.value === "reference" ? "reference" : "base")}
                    >
                      <option value="base" disabled={!canUploadBase}>
                        Base scene
                      </option>
                      <option value="reference">Reference image</option>
                    </select>
                    <input
                      className="block w-full text-sm"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className="w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium disabled:opacity-50"
                      onClick={() => void handleUpload()}
                      disabled={busy || file === null}
                    >
                      Upload Image
                    </button>
                    {hasRoot ? (
                      <p className="text-xs text-stone-500">
                        A base upload needs an empty project. Use New Scene for another root.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Versions</h2>
            {snapshot === null || snapshot.versions.length === 0 ? (
              <p className="mt-2 text-sm text-stone-600">No versions yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {snapshot.versions.map((version) => {
                  const active = version.id === snapshot.project.activeVersionId;
                  const provenance = versionProvenance(version);
                  return (
                    <li key={version.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md px-2 py-2 text-left text-sm ${
                          active ? "bg-stone-900 text-white" : "bg-stone-50 text-stone-700 hover:bg-stone-100"
                        }`}
                        onClick={() => void handleSelectVersion(version.id)}
                        disabled={busy}
                      >
                        <span className="block font-medium">
                          {version.origin} {shortId(version.id)}
                        </span>
                        <span className={`block text-xs ${active ? "text-stone-300" : "text-stone-500"}`}>
                          {version.parentVersionId === null ? "root" : `child of ${shortId(version.parentVersionId)}`}
                          {provenance !== null ? ` · ${provenance}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>

        <section className="min-h-[420px] rounded-xl border border-stone-300 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Scene</h2>
            {activeVersion !== null ? (
              <span className="text-xs text-stone-500">
                Active: {activeVersion.origin} {shortId(activeVersion.id)}
                {activeProvenance !== null ? ` · ${activeProvenance}` : ""}
              </span>
            ) : null}
          </div>
          {activeVersion === null ? (
            <div className="mt-4 flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-sm text-stone-600">
              Choose the bundled sample or upload a base image to create a root scene.
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-lg border border-stone-200 bg-stone-100">
              <Image
                src={`/api/assets/${activeVersion.imageAssetId}`}
                alt="Active canonical scene"
                width={1024}
                height={1024}
                unoptimized
                className="h-auto w-full"
              />
            </div>
          )}
        </section>

        <aside className="space-y-4">
          {error !== null ? (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}
          {notice !== null ? (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
              {notice}
            </div>
          ) : null}

          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Health</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Status</dt>
                <dd className="font-medium">{health?.status ?? "unknown"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Database</dt>
                <dd className="font-medium">{health?.databaseReady ? "ready" : "not ready"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Worker</dt>
                <dd className="font-medium">{health?.worker.status ?? "unknown"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Sample</dt>
                <dd className="font-medium">{health?.fixtures.sampleProvenance ?? "missing"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Licensed photos</dt>
                <dd className="font-medium">{health?.fixtures.licensedPhotosReady ? "ready" : "deferred"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">SAM fixture</dt>
                <dd className="font-medium">{health?.fixtures.samFixtureReady ? "ready" : "not captured"}</dd>
              </div>
            </dl>
            {health?.status === "not_ready" ? (
              <p className="mt-3 text-xs text-amber-800">
                Local setup is incomplete. Run `npm run fixtures:prepare` and `npm run db:migrate`.
              </p>
            ) : null}
          </section>

          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Budget</h2>
            {snapshot === null ? (
              <p className="mt-2 text-sm text-stone-600">No project selected.</p>
            ) : (
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Limit</dt>
                  <dd className="font-medium">
                    ${(snapshot.project.budgetLimitUsdMicros / 1_000_000).toFixed(2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Pricing</dt>
                  <dd className="font-medium">{snapshot.pricing.version}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Image reservation</dt>
                  <dd className="font-medium">
                    ${(snapshot.pricing.reservations.imageUsdMicros / 1_000_000).toFixed(2)}
                  </dd>
                </div>
              </dl>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Generation, SAM selection and editing are added in later phases.
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}

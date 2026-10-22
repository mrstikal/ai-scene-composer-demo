"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SCENE_PRESETS, type ScenePresetId } from "@/config/scene-presets";
import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import { CostSummary } from "@/components/costs/CostSummary";
import { EditPanel, type EditFormInput } from "@/components/editor/EditPanel";
import { SceneCanvas } from "@/components/editor/SceneCanvas";
import { SelectionPanel } from "@/components/editor/SelectionPanel";
import type { Evaluation, MaskPaddingPx, Point } from "@/lib/contracts/domain";
import { shouldApplySelection, type PendingSelectionRequest } from "@/lib/ui/selection-guard";
import { createSubmitKeyStore } from "@/lib/ui/submit-keys";
import type {
  AssetUploadResponse,
  ComparisonResponse,
  EditResponse,
  GenerationInput,
  GenerationResponse,
  HealthResponse,
  ProjectCostsDto,
  ProjectListDto,
  ProjectSnapshotDto,
  RetryResponse,
  RunSummaryDto,
  SampleImportResponse,
  SegmentationResponse,
} from "@/lib/contracts/api";

class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new ApiRequestError(
      body?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
    );
  }
  return body as T;
}

async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { cache: "no-store", signal });
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
  const [costs, setCosts] = useState<ProjectCostsDto | null>(null);
  const [costsError, setCostsError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [tab, setTab] = useState<"sample" | "upload" | "generate">("sample");
  const [generationMode, setGenerationMode] = useState<"preset" | "custom">("preset");
  const [selectedPresetId, setSelectedPresetId] = useState<ScenePresetId | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [costAccepted, setCostAccepted] = useState(false);
  const [role, setRole] = useState<"base" | "reference">("base");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionWarning, setConnectionWarning] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<"positive" | "negative">("positive");
  const [positivePoint, setPositivePoint] = useState<Point | null>(null);
  const [negativePoint, setNegativePoint] = useState<Point | null>(null);
  const [selectedSelectionId, setSelectedSelectionId] = useState<string | null>(null);
  const [selectionUiVersionId, setSelectionUiVersionId] = useState<string | null>(null);
  const [paddingPx, setPaddingPx] = useState<MaskPaddingPx>(16);
  const [maskVisible, setMaskVisible] = useState(true);
  const [maskOpacity, setMaskOpacity] = useState(0.35);
  const [allowedVisible, setAllowedVisible] = useState(true);
  const [pendingSelection, setPendingSelection] = useState<
    (PendingSelectionRequest & { runId: string }) | null
  >(null);
  const [selectedEditRunId, setSelectedEditRunId] = useState<string | null>(null);
  const [selectedComparisonGroupId, setSelectedComparisonGroupId] = useState<string | null>(null);
  const [selectionSubmitting, setSelectionSubmitting] = useState<{
    projectId: string;
    sourceVersionId: string;
  } | null>(null);
  const [selectionAttemptFailed, setSelectionAttemptFailed] = useState(false);
  const [pollNow, setPollNow] = useState(0);
  const submitKeys = useRef(createSubmitKeyStore());
  const currentProjectIdRef = useRef<string | null>(null);
  const snapshotRequestSeqRef = useRef(0);
  const selectionInFlightRef = useRef<string | null>(null);
  const selectionRequestSeqRef = useRef(0);

  function submitKey(operation: string, signature: string): string {
    return submitKeys.current.keyFor(operation, signature);
  }

  function clearSubmitKey(operation: string): void {
    submitKeys.current.clear(operation);
  }

  function clearSubmitKeyOnRejection(operation: string, cause: unknown): void {
    if (cause instanceof ApiRequestError && cause.status < 500) {
      clearSubmitKey(operation);
    }
  }

  const loadProject = useCallback(async (id: string) => {
    const requestSeq = ++snapshotRequestSeqRef.current;
    const next = await apiRequest<ProjectSnapshotDto>(`/api/projects/${id}`);
    if (requestSeq !== snapshotRequestSeqRef.current) return;
    currentProjectIdRef.current = id;
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
          currentProjectIdRef.current = null;
          setProjectId(null);
          setSnapshot(null);
          return;
        }

        const requestSeq = ++snapshotRequestSeqRef.current;
        const next = await apiRequest<ProjectSnapshotDto>(`/api/projects/${selected}`);
        if (cancelled || requestSeq !== snapshotRequestSeqRef.current) return;
        currentProjectIdRef.current = selected;
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
  const activeVersionId = activeVersion?.id ?? null;
  const activeProvenance = activeVersion === null ? null : versionProvenance(activeVersion);
  const latestGenerationRun =
    snapshot?.runs.filter((run) => run.kind === "generate").at(-1) ?? null;
  const hasActiveRuns =
    snapshot?.runs.some((run) => run.status === "queued" || run.status === "running") ?? false;
  const mockMode = health?.modes.ai !== "live";
  const imageReservationUsdMicros = mockMode
    ? 0
    : snapshot?.pricing.reservations.imageUsdMicros ?? 0;
  const segmentationReservationUsdMicros =
    snapshot?.pricing.reservations.segmentationUsdMicros ?? 0;
  const segmentationAvailable = health?.providers.segmentation.available ?? false;
  const segmentationReason = health?.providers.segmentation.reason ?? null;

  const selectionStateMatches = selectionUiVersionId === activeVersionId;
  const effectiveSelectionMode = selectionStateMatches ? selectionMode : "positive";
  const effectivePositivePoint = selectionStateMatches ? positivePoint : null;
  const effectiveNegativePoint = selectionStateMatches ? negativePoint : null;

  const selectionsForActive =
    activeVersionId === null
      ? []
      : snapshot?.selections.filter(
          (selection) => selection.sourceVersionId === activeVersionId,
        ) ?? [];
  const latestSelection = selectionsForActive.at(-1) ?? null;

  const segmentRunsForActive =
    activeVersionId === null
      ? []
      : snapshot?.runs.filter(
          (run) => run.kind === "segment" && run.parentVersionId === activeVersionId,
        ) ?? [];
  const pendingSegmentRun =
    segmentRunsForActive
      .filter((run) => run.status === "queued" || run.status === "running")
      .at(-1) ?? null;
  const latestSegmentRun = segmentRunsForActive.at(-1) ?? null;

  const editRunsForActive =
    activeVersionId === null
      ? []
      : snapshot?.runs.filter(
          (run) =>
            run.kind === "edit" &&
            run.parentVersionId === activeVersionId &&
            run.comparisonGroupId === null,
        ) ?? [];
  const selectedEditRun =
    snapshot?.runs.find(
      (run) =>
        run.id === selectedEditRunId &&
        run.kind === "edit" &&
        run.comparisonGroupId === null,
    ) ?? null;
  const latestEditRun = selectedEditRun ?? editRunsForActive.at(-1) ?? null;
  const editProviderAvailable = health?.providers.images.available ?? false;
  const editProviderReason = health?.providers.images.reason ?? null;
  const editReservationUsdMicros = mockMode ? 0 : imageReservationUsdMicros;
  const comparisonReservationUsdMicros = mockMode
    ? 0
    : snapshot?.pricing.reservations.comparisonUsdMicros ?? 0;

  const comparisonGroups = new Map<string, RunSummaryDto[]>();
  for (const run of snapshot?.runs ?? []) {
    if (run.comparisonGroupId === null) continue;
    const groupRuns = comparisonGroups.get(run.comparisonGroupId) ?? [];
    groupRuns.push(run);
    comparisonGroups.set(run.comparisonGroupId, groupRuns);
  }
  const comparisonGroupEntries = [...comparisonGroups.entries()].map(([id, runs]) => ({
    id,
    runs,
    createdAt: Math.min(...runs.map((run) => run.createdAt)),
  }));
  const activeComparisonGroups = comparisonGroupEntries.filter((group) =>
    group.runs.some((run) => run.parentVersionId === activeVersionId),
  );
  const selectedComparisonGroup =
    comparisonGroupEntries.find((group) => group.id === selectedComparisonGroupId) ?? null;
  const latestComparisonGroup =
    selectedComparisonGroup ??
    (activeComparisonGroups.length > 0 ? activeComparisonGroups : comparisonGroupEntries)
      .sort((left, right) => left.createdAt - right.createdAt)
      .at(-1) ??
    null;
  const editHistory = (snapshot?.runs ?? [])
    .filter((run) => run.kind === "edit" && run.comparisonGroupId === null)
    .sort((left, right) => left.createdAt - right.createdAt);

  const costSignature =
    snapshot === null
      ? ""
      : snapshot.runs
          .map(
            (run) =>
              `${run.id}:${run.status}:${run.cost.budgetChargeUsdMicros}:${run.cost.amountUsdMicros}:${run.cost.provenance}:${run.cost.outcome}`,
          )
          .join("|");

  const pendingRunForRequest =
    pendingSelection === null
      ? null
      : snapshot?.runs.find((run) => run.id === pendingSelection.runId) ?? null;
  const pendingRunTerminal =
    pendingRunForRequest !== null &&
    pendingRunForRequest.status !== "queued" &&
    pendingRunForRequest.status !== "running";
  const pendingSelectionResult =
    pendingRunForRequest === null || pendingRunForRequest.outputSelectionId === null
      ? null
      : snapshot?.selections.find(
          (selection) => selection.id === pendingRunForRequest.outputSelectionId,
        ) ?? null;
  const pendingGuardPasses =
    pendingRunTerminal &&
    pendingSelection !== null &&
    pendingRunForRequest !== null &&
    shouldApplySelection({
      activeVersionId,
      pending: pendingSelection,
      run: pendingRunForRequest,
      selection: pendingSelectionResult,
    });
  const pendingGuardFailedForActiveVersion =
    pendingRunTerminal &&
    pendingSelection !== null &&
    pendingSelection.sourceVersionId === activeVersionId &&
    !pendingGuardPasses;

  const effectiveSelectedSelectionId = pendingGuardPasses
    ? pendingRunForRequest?.outputSelectionId ?? null
    : selectionStateMatches
      ? selectedSelectionId
      : null;
  const selectedSelection =
    effectiveSelectedSelectionId === null
      ? null
      : selectionsForActive.find(
          (selection) => selection.id === effectiveSelectedSelectionId,
        ) ?? null;
  const activeSelection =
    pendingGuardFailedForActiveVersion || selectionAttemptFailed
      ? null
      : selectedSelection ?? latestSelection;

  const submittingThisView =
    selectionSubmitting !== null &&
    selectionSubmitting.projectId === projectId &&
    selectionSubmitting.sourceVersionId === activeVersionId &&
    !pendingRunTerminal;
  const selectionPending = submittingThisView || pendingSegmentRun !== null;
  const displaySelection = selectionPending ? null : activeSelection;
  const displayPositivePoint =
    effectivePositivePoint ?? displaySelection?.positivePoints[0] ?? null;
  const displayNegativePoint =
    effectiveNegativePoint ?? displaySelection?.negativePoints[0] ?? null;
  const activeVariant =
    displaySelection === null
      ? null
      : displaySelection.regions.variants[String(paddingPx) as "16" | "32"];

  const selectedPreset =
    selectedPresetId === null
      ? null
      : SCENE_PRESETS.find((preset) => preset.id === selectedPresetId) ?? null;
  const generationInput: GenerationInput | null =
    generationMode === "preset"
      ? selectedPresetId === null
        ? null
        : { mode: "preset", presetId: selectedPresetId }
      : customPrompt.trim().length > 0
        ? { mode: "custom", prompt: customPrompt.trim() }
        : null;
  const generationReady =
    projectId !== null &&
    snapshot !== null &&
    generationInput !== null &&
    costAccepted &&
    !busy;
  const workerWarning =
    hasActiveRuns &&
    (health?.worker.status === "missing" || health?.worker.status === "stale");

  useEffect(() => {
    if (projectId === null || (!hasActiveRuns && pollNow === 0)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1500;
    const controller = new AbortController();

    async function poll(): Promise<void> {
      const requestEpoch = snapshotRequestSeqRef.current;
      try {
        const [nextSnapshot, nextHealth] = await Promise.all([
          apiRequest<ProjectSnapshotDto>(`/api/projects/${projectId}`, {
            signal: controller.signal,
          }),
          fetchHealth(controller.signal),
        ]);
        if (cancelled) return;
        if (
          requestEpoch === snapshotRequestSeqRef.current &&
          currentProjectIdRef.current === projectId
        ) {
          setSnapshot(nextSnapshot);
        }
        setHealth(nextHealth);
        setPollNow(0);
        setConnectionWarning(null);
        delay = 1500;
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiRequestError && cause.status === 404) {
          cancelled = true;
          setError("Project not found.");
          return;
        }
        setConnectionWarning("Connection issue while polling. Jobs remain persisted.");
        delay = delay === 1500 ? 3000 : delay === 3000 ? 6000 : 15000;
      } finally {
        if (!cancelled) timer = setTimeout(poll, delay);
      }
    }

    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [projectId, hasActiveRuns, pollNow]);

  useEffect(() => {
    if (projectId === null) return;

    let cancelled = false;
    async function loadCosts(): Promise<void> {
      try {
        const next = await apiRequest<ProjectCostsDto>(`/api/projects/${projectId}/costs`);
        if (cancelled) return;
        setCosts(next);
        setCostsError(null);
      } catch (cause) {
        if (cancelled) return;
        setCostsError(cause instanceof Error ? cause.message : "Costs load failed.");
      }
    }

    void loadCosts();
    return () => {
      cancelled = true;
    };
  }, [projectId, costSignature]);

  async function handleCreateProject(): Promise<void> {
    selectionRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCosts(null);
    setCostsError(null);
    try {
      const body = title.trim().length > 0 ? { title: title.trim() } : {};
      const result = await apiRequest<{ projectId: string }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTitle("");
      setSelectionUiVersionId(null);
      setSelectionAttemptFailed(false);
      setSelectionMode("positive");
      setPositivePoint(null);
      setNegativePoint(null);
      setSelectedSelectionId(null);
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
    snapshotRequestSeqRef.current += 1;
    selectionRequestSeqRef.current += 1;
    currentProjectIdRef.current = null;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCosts(null);
    setCostsError(null);
    setSelectionUiVersionId(null);
    setSelectionAttemptFailed(false);
    setSelectionMode("positive");
    setPositivePoint(null);
    setNegativePoint(null);
    setSelectedSelectionId(null);
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
    const operation = "sample";
    const key = submitKey(operation, `${projectId}:living-room-v1`);
    try {
      await apiRequest<SampleImportResponse>(`/api/projects/${projectId}/sample`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ sampleId: "living-room-v1" }),
      });
      clearSubmitKey(operation);
      await loadProject(projectId);
      setNotice("Bundled sample imported as the root scene.");
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
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
    const operation = "upload";
    const key = submitKey(
      operation,
      `${projectId}:${effectiveRole}:${file.name}:${file.size}:${file.lastModified}`,
    );
    try {
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("role", effectiveRole);
      form.set("file", file);
      const result = await apiRequest<AssetUploadResponse>("/api/assets", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: form,
      });
      clearSubmitKey(operation);
      setFile(null);
      await loadProject(projectId);
      setNotice(
        result.rootVersionId === null
          ? "Reference image uploaded."
          : "Base image uploaded as the root scene.",
      );
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadReference(file: File): Promise<string | null> {
    if (projectId === null) return null;
    setBusy(true);
    setError(null);
    setNotice(null);
    const operation = "reference-upload";
    const key = submitKey(
      operation,
      `${projectId}:${file.name}:${file.size}:${file.lastModified}`,
    );
    try {
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("role", "reference");
      form.set("file", file);
      const result = await apiRequest<AssetUploadResponse>("/api/assets", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: form,
      });
      clearSubmitKey(operation);
      try {
        await loadProject(projectId);
      } catch {
        setConnectionWarning("Reference uploaded. Refresh the project to see it in the picker.");
        setPollNow((value) => value + 1);
      }
      setNotice("Reference image uploaded.");
      return result.assetId;
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Reference upload failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleEditSubmit(input: EditFormInput): Promise<boolean> {
    if (projectId === null || snapshot === null || activeVersionId === null) return false;
    if (activeSelection === null) {
      setError("A successful SAM selection is required before editing.");
      return false;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    const operation = "edit";
    const key = submitKey(
      operation,
      JSON.stringify({
        projectId,
        parentVersionId: activeVersionId,
        selectionId: activeSelection.id,
        paddingPx,
        targetLabel: input.targetLabel,
        instruction: input.instruction,
        referenceIds: input.referenceIds,
        model: input.model,
      }),
    );

    try {
      await apiRequest<EditResponse>("/api/edits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          projectId,
          parentVersionId: activeVersionId,
          selectionId: activeSelection.id,
          paddingPx,
          targetLabel: input.targetLabel,
          instruction: input.instruction,
          referenceAssetIds: input.referenceIds,
          model: input.model,
          costConsent: {
            pricingVersion: snapshot.pricing.version,
            reservationUsdMicros: editReservationUsdMicros,
            acknowledged: true,
          },
        }),
      });
      clearSubmitKey(operation);
      setSelectedEditRunId(null);
      setSelectedComparisonGroupId(null);
      try {
        await loadProject(projectId);
      } catch {
        setConnectionWarning("Edit queued. Refresh the project to see progress.");
        setPollNow((value) => value + 1);
      }
      setNotice("Edit queued. The worker will create a child version.");
      return true;
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Edit enqueue failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCompareSubmit(input: EditFormInput): Promise<boolean> {
    if (projectId === null || snapshot === null || activeVersionId === null) return false;
    if (activeSelection === null) {
      setError("A successful SAM selection is required before comparing models.");
      return false;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    const operation = "comparison";
    const key = submitKey(
      operation,
      JSON.stringify({
        projectId,
        parentVersionId: activeVersionId,
        selectionId: activeSelection.id,
        paddingPx,
        targetLabel: input.targetLabel,
        instruction: input.instruction,
        referenceIds: input.referenceIds,
      }),
    );

    try {
      await apiRequest<ComparisonResponse>("/api/comparisons", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          projectId,
          parentVersionId: activeVersionId,
          selectionId: activeSelection.id,
          paddingPx,
          targetLabel: input.targetLabel,
          instruction: input.instruction,
          referenceAssetIds: input.referenceIds,
          costConsent: {
            pricingVersion: snapshot.pricing.version,
            reservationUsdMicros: comparisonReservationUsdMicros,
            acknowledged: true,
          },
        }),
      });
      clearSubmitKey(operation);
      setSelectedEditRunId(null);
      setSelectedComparisonGroupId(null);
      try {
        await loadProject(projectId);
      } catch {
        setConnectionWarning("Comparison queued. Refresh the project to see progress.");
        setPollNow((value) => value + 1);
      }
      setNotice("Comparison queued: Flare and Sunburst share the frozen input.");
      return true;
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Comparison enqueue failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleEvaluation(runId: string, evaluation: Evaluation): Promise<boolean> {
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/api/runs/${runId}/evaluation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evaluation),
      });
      if (projectId !== null) {
        try {
          await loadProject(projectId);
        } catch {
          setConnectionWarning("Evaluation saved. Refresh the project to see it.");
          setPollNow((value) => value + 1);
        }
      }
      setNotice("Evaluation saved.");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Evaluation save failed.");
      return false;
    }
  }

  async function handleSelectVersion(versionId: string): Promise<void> {
    if (projectId === null) return;
    selectionRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    setSelectedEditRunId(null);
    setSelectedComparisonGroupId(null);
    if (versionId !== activeVersionId) {
      setSelectionUiVersionId(versionId);
      setSelectionAttemptFailed(false);
      setSelectionMode("positive");
      setPositivePoint(null);
      setNegativePoint(null);
      setSelectedSelectionId(null);
    }
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

  async function handleGenerate(): Promise<void> {
    if (!generationReady || projectId === null || snapshot === null || generationInput === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const operation = "generate";
    const key = submitKey(operation, `${projectId}:${JSON.stringify(generationInput)}`);
    try {
      await apiRequest<GenerationResponse>("/api/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          projectId,
          input: generationInput,
          costConsent: {
            pricingVersion: snapshot.pricing.version,
            reservationUsdMicros: imageReservationUsdMicros,
            acknowledged: true,
          },
        }),
      });
      clearSubmitKey(operation);
      try {
        await loadProject(projectId);
      } catch {
        setConnectionWarning("Generation queued. Refresh the project to see progress.");
        setPollNow((value) => value + 1);
      }
      setNotice("Generation queued. The worker will install the root when it completes.");
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Generation enqueue failed.");
    } finally {
      setBusy(false);
    }
  }

  async function enqueueSelection(positive: Point, negative: Point | null): Promise<void> {
    if (projectId === null || snapshot === null || activeVersionId === null) return;
    if (!segmentationAvailable) {
      setError("SAM selection is unavailable.");
      return;
    }

    const scopeKey = `${projectId}:${activeVersionId}`;
    if (selectionInFlightRef.current === scopeKey) return;
    selectionInFlightRef.current = scopeKey;
    const attemptId = ++selectionRequestSeqRef.current;

    const startedProjectId = projectId;
    const startedVersionId = activeVersionId;
    const pricingVersion = snapshot.pricing.version;
    setSelectionSubmitting({ projectId: startedProjectId, sourceVersionId: startedVersionId });
    setSelectionAttemptFailed(false);
    setError(null);
    setNotice(null);

    const operation = "segment";
    const key = submitKey(
      operation,
      `${startedProjectId}:${startedVersionId}:${JSON.stringify({ positive, negative })}`,
    );

    try {
      const result = await apiRequest<SegmentationResponse>("/api/segmentations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          projectId: startedProjectId,
          sourceVersionId: startedVersionId,
          positivePoints: [positive],
          negativePoints: negative === null ? [] : [negative],
          costConsent: {
            pricingVersion,
            reservationUsdMicros: segmentationReservationUsdMicros,
            acknowledged: true,
          },
        }),
      });
      clearSubmitKey(operation);
      if (attemptId !== selectionRequestSeqRef.current) return;
      setSelectionAttemptFailed(false);
      setPendingSelection({
        sourceVersionId: startedVersionId,
        positivePoints: [positive],
        negativePoints: negative === null ? [] : [negative],
        runId: result.runId,
      });

      try {
        const requestEpoch = snapshotRequestSeqRef.current;
        const next = await apiRequest<ProjectSnapshotDto>(`/api/projects/${startedProjectId}`);
        if (
          attemptId === selectionRequestSeqRef.current &&
          currentProjectIdRef.current === startedProjectId &&
          requestEpoch === snapshotRequestSeqRef.current
        ) {
          setSnapshot(next);
        }
      } catch {
        if (attemptId === selectionRequestSeqRef.current) {
          setConnectionWarning("Selection queued. Refresh the project to see progress.");
          setPollNow((value) => value + 1);
        }
      }
      if (attemptId !== selectionRequestSeqRef.current) return;
      setNotice("Selection queued. The worker will save the mask.");
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      if (attemptId !== selectionRequestSeqRef.current) return;
      setError(cause instanceof Error ? cause.message : "Selection enqueue failed.");
      setSelectionAttemptFailed(true);
      setPendingSelection(null);
      setSelectionSubmitting(null);
    } finally {
      if (selectionInFlightRef.current === scopeKey) selectionInFlightRef.current = null;
    }
  }

  async function handleCanvasSelect(point: Point): Promise<void> {
    if (projectId === null || snapshot === null || activeVersionId === null) return;
    if (selectionPending || !segmentationAvailable) return;

    setSelectionUiVersionId(activeVersionId);
    setPendingSelection(null);
    setSelectionSubmitting(null);
    setSelectionAttemptFailed(false);

    if (effectiveSelectionMode === "negative") {
      const base = displayPositivePoint;
      if (base === null) return;
      if (base.x === point.x && base.y === point.y) {
        setError("Positive and negative points must differ.");
        return;
      }
      setPositivePoint(base);
      setNegativePoint(point);
      setSelectedSelectionId(null);
      await enqueueSelection(base, point);
      return;
    }

    setPositivePoint(point);
    setNegativePoint(null);
    setSelectedSelectionId(null);
    await enqueueSelection(point, null);
  }

  function handleModeChange(mode: "positive" | "negative"): void {
    setSelectionUiVersionId(activeVersionId);
    setSelectionAttemptFailed(false);
    setSelectionMode(mode);
  }

  function handleSelectSavedSelection(selectionId: string | null): void {
    selectionRequestSeqRef.current += 1;
    setSelectionUiVersionId(activeVersionId);
    setPendingSelection(null);
    setSelectionSubmitting(null);
    setSelectionAttemptFailed(false);
    setSelectedSelectionId(selectionId);
    setPositivePoint(null);
    setNegativePoint(null);
    setSelectionMode("positive");
  }

  async function handleOpenEditRun(run: RunSummaryDto): Promise<void> {
    if (projectId === null) return;
    selectionRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (run.parentVersionId !== null && run.parentVersionId !== activeVersionId) {
        await apiRequest(`/api/projects/${projectId}/active-version`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId: run.parentVersionId }),
        });
      }
      setSelectedEditRunId(run.id);
      setSelectedComparisonGroupId(null);
      await loadProject(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run history could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenComparison(group: {
    id: string;
    runs: RunSummaryDto[];
  }): Promise<void> {
    if (projectId === null) return;
    selectionRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const parentVersionId = group.runs.find((run) => run.parentVersionId !== null)?.parentVersionId ?? null;
      if (parentVersionId !== null && parentVersionId !== activeVersionId) {
        await apiRequest(`/api/projects/${projectId}/active-version`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId: parentVersionId }),
        });
      }
      setSelectedComparisonGroupId(group.id);
      setSelectedEditRunId(null);
      await loadProject(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Comparison history could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry(run: RunSummaryDto): Promise<void> {
    if (projectId === null || snapshot === null) return;
    if (
      run.possibleDuplicateCharge &&
      !window.confirm(
        "The previous provider attempt has an unknown outcome and may already have been billed. Retry anyway?",
      )
    ) {
      return;
    }
    const retryReservation = run.retryMode === "local" ? 0 : run.retryReservationUsdMicros;
    setBusy(true);
    setError(null);
    setNotice(null);
    const operation = `retry:${run.id}`;
    const key = submitKey(operation, `${run.id}:${run.retryMode}`);
    try {
      const result = await apiRequest<RetryResponse>(`/api/runs/${run.id}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          costConsent: {
            pricingVersion: snapshot.pricing.version,
            reservationUsdMicros: retryReservation,
            acknowledged: true,
          },
          acknowledgePossibleDuplicateCharge: run.possibleDuplicateCharge,
        }),
      });
      clearSubmitKey(operation);
      if (run.kind === "segment" && run.segmentInput !== null) {
        setSelectionUiVersionId(run.segmentInput.sourceVersionId);
        setPendingSelection({
          sourceVersionId: run.segmentInput.sourceVersionId,
          positivePoints: run.segmentInput.positivePoints,
          negativePoints: run.segmentInput.negativePoints,
          runId: result.runId,
        });
        setSelectionSubmitting({
          projectId,
          sourceVersionId: run.segmentInput.sourceVersionId,
        });
        setSelectedSelectionId(null);
        }
      try {
        await loadProject(projectId);
      } catch {
        setConnectionWarning("Retry queued. Refresh the project to see progress.");
        setPollNow((value) => value + 1);
      }
      setNotice("Retry queued.");
    } catch (cause) {
      clearSubmitKeyOnRejection(operation, cause);
      setError(cause instanceof Error ? cause.message : "Retry failed.");
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
            <p className="text-sm text-stone-600">
              Upload, sample, generation, SAM selection, editing, comparison and version tree
            </p>
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
        <aside className="min-w-0 space-y-4">
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
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-stone-100 p-1">
                    <button
                      type="button"
                      aria-pressed={tab === "sample"}
                      className={`rounded-md px-2 py-1.5 text-sm ${tab === "sample" ? "bg-white shadow-sm" : "text-stone-600"}`}
                      onClick={() => setTab("sample")}
                    >
                      Sample
                    </button>
                    <button
                      type="button"
                      aria-pressed={tab === "upload"}
                      className={`rounded-md px-2 py-1.5 text-sm ${tab === "upload" ? "bg-white shadow-sm" : "text-stone-600"}`}
                      onClick={() => setTab("upload")}
                    >
                      Upload
                    </button>
                    <button
                      type="button"
                      aria-pressed={tab === "generate"}
                      className={`rounded-md px-2 py-1.5 text-sm ${tab === "generate" ? "bg-white shadow-sm" : "text-stone-600"}`}
                      onClick={() => setTab("generate")}
                    >
                      Generate
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

                {!hasRoot && tab === "generate" ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      {SCENE_PRESETS.map((preset) => {
                        const selected = generationMode === "preset" && selectedPresetId === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            aria-pressed={selected}
                            className={`w-full rounded-lg border px-3 py-2 text-left ${
                              selected
                                ? "border-stone-900 bg-stone-900 text-white"
                                : "border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100"
                            }`}
                            onClick={() => {
                              setGenerationMode("preset");
                              setSelectedPresetId(preset.id);
                            }}
                          >
                            <span className="block text-sm font-medium">{preset.label}</span>
                            <span className={`mt-1 block text-xs ${selected ? "text-stone-300" : "text-stone-500"}`}>
                              {preset.prompt}
                            </span>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        aria-pressed={generationMode === "custom"}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-medium ${
                          generationMode === "custom"
                            ? "border-stone-900 bg-stone-900 text-white"
                            : "border-stone-300 bg-stone-50 text-stone-700 hover:bg-stone-100"
                        }`}
                        onClick={() => setGenerationMode("custom")}
                      >
                        Custom Prompt
                      </button>
                    </div>

                    {generationMode === "preset" && selectedPreset !== null ? (
                      <div className="rounded-md border border-stone-200 bg-stone-50 p-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                          Resolved preset prompt
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-stone-600">
                          {selectedPreset.prompt}
                        </p>
                      </div>
                    ) : null}

                    {generationMode === "custom" ? (
                      <div className="space-y-1">
                        <label className="block text-xs font-medium text-stone-600" htmlFor="custom-prompt">
                          Custom prompt
                        </label>
                        <textarea
                          id="custom-prompt"
                          className="min-h-24 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                          maxLength={2000}
                          value={customPrompt}
                          onChange={(event) => setCustomPrompt(event.target.value)}
                          placeholder="Describe the scene you want to create."
                        />
                        <p className="text-right text-xs text-stone-500">
                          {customPrompt.trim().length}/2000
                        </p>
                      </div>
                    ) : null}

                    <label className="flex items-start gap-2 text-xs text-stone-600">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={costAccepted}
                        onChange={(event) => setCostAccepted(event.target.checked)}
                      />
                      <span>
                        I confirm the estimated generation cost.
                        {mockMode
                          ? " Mock run: no provider charge."
                          : ` Reserved estimate: $${(imageReservationUsdMicros / 1_000_000).toFixed(2)}.`}
                      </span>
                    </label>

                    <button
                      type="button"
                      className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                      onClick={() => void handleGenerate()}
                      disabled={!generationReady}
                    >
                      Generate Scene
                    </button>

                    {latestGenerationRun !== null &&
                    (latestGenerationRun.status === "queued" || latestGenerationRun.status === "running") ? (
                      <p className="text-xs text-stone-600">
                        Generation {latestGenerationRun.status}: {latestGenerationRun.stage}
                      </p>
                    ) : null}
                    {latestGenerationRun !== null &&
                    (latestGenerationRun.status === "failed" || latestGenerationRun.status === "needs_review") ? (
                      <p className="text-xs text-red-700">
                        {latestGenerationRun.errorMessage ?? "Generation failed."}
                      </p>
                    ) : null}
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

          <section className="rounded-xl border border-stone-300 bg-white p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
              Run history
            </h2>
            <p className="mt-2 text-xs font-medium text-stone-600">Edits</p>
            {editHistory.length === 0 ? (
              <p className="mt-1 text-xs text-stone-500">No single-model edits yet.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {editHistory.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                        run.id === selectedEditRunId
                          ? "bg-stone-900 text-white"
                          : "bg-stone-50 text-stone-700 hover:bg-stone-100"
                      }`}
                      onClick={() => void handleOpenEditRun(run)}
                      disabled={busy}
                    >
                      <span className="block font-medium">
                        Edit {shortId(run.id)} · {run.status}
                      </span>
                      <span
                        className={`block ${
                          run.id === selectedEditRunId ? "text-stone-300" : "text-stone-500"
                        }`}
                      >
                        {run.model} · {run.executionMode} · parent{" "}
                        {run.parentVersionId === null ? "none" : shortId(run.parentVersionId)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs font-medium text-stone-600">Comparisons</p>
            {comparisonGroupEntries.length === 0 ? (
              <p className="mt-1 text-xs text-stone-500">No comparison groups yet.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {comparisonGroupEntries.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                        group.id === selectedComparisonGroupId
                          ? "bg-stone-900 text-white"
                          : "bg-stone-50 text-stone-700 hover:bg-stone-100"
                      }`}
                      onClick={() => void handleOpenComparison(group)}
                      disabled={busy}
                    >
                      <span className="block font-medium">
                        Comparison {shortId(group.id)}
                      </span>
                      <span
                        className={`block ${
                          group.id === selectedComparisonGroupId
                            ? "text-stone-300"
                            : "text-stone-500"
                        }`}
                      >
                        {group.runs.length} attempts ·{" "}
                        {group.runs.some(
                          (run) => run.status === "queued" || run.status === "running",
                        )
                          ? "active"
                          : "finished"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {snapshot?.versions.some(
              (version) => version.origin === "edit" && version.originatingRunId !== null,
            ) ? (
              <>
                <p className="mt-3 text-xs font-medium text-stone-600">Versions to runs</p>
                <ul className="mt-1 space-y-1">
                  {snapshot.versions
                    .filter(
                      (version) =>
                        version.origin === "edit" && version.originatingRunId !== null,
                    )
                    .map((version) => {
                      const run =
                        snapshot.runs.find(
                          (candidate) => candidate.id === version.originatingRunId,
                        ) ?? null;
                      const group =
                        run?.comparisonGroupId === null || run?.comparisonGroupId === undefined
                          ? null
                          : comparisonGroupEntries.find(
                              (entry) => entry.id === run.comparisonGroupId,
                            ) ?? null;
                      if (run === null) return null;
                      return (
                        <li key={version.id}>
                          <button
                            type="button"
                            className="w-full rounded-md bg-stone-50 px-2 py-1.5 text-left text-xs text-stone-700 hover:bg-stone-100"
                            onClick={() =>
                              group !== null
                                ? void handleOpenComparison(group)
                                : void handleOpenEditRun(run)
                            }
                            disabled={busy}
                          >
                            Open {version.origin} {shortId(version.id)} origin run{" "}
                            {shortId(run.id)}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </>
            ) : null}
          </section>
        </aside>

        <section className="min-h-[420px] min-w-0 rounded-xl border border-stone-300 bg-white p-4">
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
            <SceneCanvas
              imageAssetId={activeVersion.imageAssetId}
              alt="Active canonical scene"
              maskAssetId={displaySelection?.binaryMaskAssetId ?? null}
              allowedMaskAssetId={activeVariant?.allowedMaskAssetId ?? null}
              maskVisible={maskVisible}
              maskOpacity={maskOpacity}
              allowedVisible={allowedVisible}
              disabled={selectionPending || !segmentationAvailable}
              positivePoint={displayPositivePoint}
              negativePoint={displayNegativePoint}
              onSelect={(point) => void handleCanvasSelect(point)}
            />
          )}
        </section>

        <aside className="min-w-0 space-y-4">
          {error !== null ? (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}
          {notice !== null ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800"
            >
              {notice}
            </div>
          ) : null}
          {connectionWarning !== null ? (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {connectionWarning}
            </div>
          ) : null}
          {workerWarning ? (
            <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              The worker is {health?.worker.status}. Jobs persist and will resume when the worker is
              started or recovered. An unclean lock may take up to two minutes to expire.
            </div>
          ) : null}

          <SelectionPanel
            activeVersionId={activeVersionId}
            selections={selectionsForActive}
            selection={activeSelection}
            pendingRun={pendingSegmentRun}
            submitting={submittingThisView}
            latestRun={latestSegmentRun}
            mode={effectiveSelectionMode}
            onModeChange={handleModeChange}
            positivePoint={displayPositivePoint}
            negativePoint={displayNegativePoint}
            paddingPx={paddingPx}
            onPaddingChange={setPaddingPx}
            maskVisible={maskVisible}
            onMaskVisibleChange={setMaskVisible}
            maskOpacity={maskOpacity}
            onMaskOpacityChange={setMaskOpacity}
            allowedVisible={allowedVisible}
            onAllowedVisibleChange={setAllowedVisible}
            onSelectSaved={handleSelectSavedSelection}
            onRetry={(run) => void handleRetry(run)}
            retryDisabled={busy || selectionPending}
            providerAvailable={segmentationAvailable}
            providerReason={segmentationReason}
            mockMode={mockMode}
            segmentationReservationUsdMicros={segmentationReservationUsdMicros}
          />

          <EditPanel
            key={`${projectId ?? "none"}:${activeVersionId ?? "none"}:${latestEditRun?.id ?? "none"}`}
            projectId={projectId}
            activeVersionId={activeVersionId}
            selection={activeSelection}
            selectionPending={selectionPending}
            paddingPx={paddingPx}
            versions={snapshot?.versions ?? []}
            references={snapshot?.references ?? []}
            latestRun={latestEditRun}
            busy={busy}
            mockMode={mockMode}
            imageReservationUsdMicros={editReservationUsdMicros}
            comparisonReservationUsdMicros={comparisonReservationUsdMicros}
            remainingBudgetUsdMicros={costs?.totals.remainingUsdMicros ?? null}
            providerAvailable={editProviderAvailable}
            providerReason={editProviderReason}
            onSubmit={handleEditSubmit}
            onCompare={handleCompareSubmit}
            onUploadReference={handleUploadReference}
            onRetry={(run) => void handleRetry(run)}
            onContinue={(versionId) => void handleSelectVersion(versionId)}
            onEvaluation={handleEvaluation}
          />

          {latestComparisonGroup !== null ? (
            <ComparisonPanel
              key={latestComparisonGroup.id}
              groupId={latestComparisonGroup.id}
              runs={latestComparisonGroup.runs}
              versions={snapshot?.versions ?? []}
              busy={busy}
              remainingBudgetUsdMicros={costs?.totals.remainingUsdMicros ?? null}
              onRetry={(run) => void handleRetry(run)}
              onContinue={(versionId) => void handleSelectVersion(versionId)}
              onEvaluation={handleEvaluation}
            />
          ) : null}

          {latestGenerationRun !== null ? (
            <section className="rounded-xl border border-stone-300 bg-white p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                Generation
              </h2>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Status</dt>
                  <dd className="font-medium">
                    {latestGenerationRun.status} / {latestGenerationRun.stage}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Mode</dt>
                  <dd className="font-medium">{latestGenerationRun.executionMode}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Model</dt>
                  <dd className="text-right font-medium">{latestGenerationRun.model}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Charge</dt>
                  <dd className="font-medium">
                    USD {(latestGenerationRun.cost.budgetChargeUsdMicros / 1_000_000).toFixed(6)}
                  </dd>
                </div>
                {latestGenerationRun.providerLatencyMs !== null ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-500">Provider latency</dt>
                    <dd className="font-medium">{latestGenerationRun.providerLatencyMs} ms</dd>
                  </div>
                ) : null}
              </dl>
              {latestGenerationRun.inputSummary !== null ? (
                <p className="mt-2 text-xs text-stone-500">
                  {latestGenerationRun.inputSummary.presetId !== null
                    ? SCENE_PRESETS.find(
                        (preset) => preset.id === latestGenerationRun.inputSummary?.presetId,
                      )?.label ?? latestGenerationRun.inputSummary.presetId
                    : "Custom prompt"}
                </p>
              ) : null}
              {latestGenerationRun.errorMessage !== null ? (
                <p className="mt-2 text-xs text-red-700">{latestGenerationRun.errorMessage}</p>
              ) : null}
              {latestGenerationRun.retryMode !== "none" ? (
                <button
                  type="button"
                  className="mt-3 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium disabled:opacity-50"
                  onClick={() => void handleRetry(latestGenerationRun)}
                  disabled={busy}
                >
                  {latestGenerationRun.retryMode === "local"
                    ? "Retry Local Processing"
                    : `Retry Generation${latestGenerationRun.retryReservationUsdMicros > 0 ? ` ($${(latestGenerationRun.retryReservationUsdMicros / 1_000_000).toFixed(2)})` : ""}`}
                </button>
              ) : null}
            </section>
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
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Pricing</h2>
            {snapshot === null ? (
              <p className="mt-2 text-sm text-stone-600">No project selected.</p>
            ) : (
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Version</dt>
                  <dd className="font-medium">{snapshot.pricing.version}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Image reservation</dt>
                  <dd className="font-medium">
                    ${(snapshot.pricing.reservations.imageUsdMicros / 1_000_000).toFixed(2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Comparison reservation</dt>
                  <dd className="font-medium">
                    ${(snapshot.pricing.reservations.comparisonUsdMicros / 1_000_000).toFixed(2)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">SAM reservation</dt>
                  <dd className="font-medium">
                    ${(snapshot.pricing.reservations.segmentationUsdMicros / 1_000_000).toFixed(6)}
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <CostSummary costs={costs} error={costsError} />
        </aside>
      </main>
    </div>
  );
}

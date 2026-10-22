"use client";

import Image from "next/image";
import { useState } from "react";

import type {
  ReferenceAssetDto,
  RunSummaryDto,
  SelectionDto,
  VersionDto,
} from "@/lib/contracts/api";
import {
  EDIT_MODELS,
  type EditModel,
  type Evaluation,
  type MaskPaddingPx,
} from "@/lib/contracts/domain";
import { EvaluationForm } from "@/components/runs/EvaluationForm";
import { RunDetailPanel } from "@/components/runs/RunDetailPanel";
import { ReferencePicker } from "./ReferencePicker";

export interface EditFormInput {
  targetLabel: string;
  instruction: string;
  referenceIds: string[];
  model: EditModel;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatUsd(micros: number | null): string {
  if (micros === null) return "unavailable";
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function ResultCard(input: {
  run: RunSummaryDto;
  versions: VersionDto[];
  busy: boolean;
  onContinue: (versionId: string) => void;
  onEvaluation: (runId: string, evaluation: Evaluation) => Promise<boolean>;
}) {
  const [view, setView] = useState<"final" | "raw">("final");
  const [beforePercent, setBeforePercent] = useState(50);
  const parentVersion =
    input.versions.find((version) => version.id === input.run.parentVersionId) ?? null;
  const finalVersion =
    input.versions.find((version) => version.id === input.run.outputVersionId) ?? null;
  const parentUrl = parentVersion === null ? null : `/api/assets/${parentVersion.imageAssetId}`;
  const finalUrl = finalVersion === null ? null : `/api/assets/${finalVersion.imageAssetId}`;
  const rawAssetId = input.run.normalizedRawAssetId ?? input.run.rawAssetId;
  const rawUrl = rawAssetId === null ? null : `/api/assets/${rawAssetId}`;
  const activeView = view === "raw" && rawUrl !== null ? "raw" : "final";

  return (
    <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-stone-700">
            Edit {shortId(input.run.id)} · {input.run.model} · {input.run.executionMode}
          </p>
          <p className="text-xs text-stone-500">
            {input.run.status}
            {input.run.providerLatencyMs !== null ? ` · ${input.run.providerLatencyMs} ms` : ""}
            {` · ${formatUsd(input.run.cost.amountUsdMicros)} ${input.run.cost.provenance ?? ""}`}
          </p>
        </div>
        <div className="flex gap-1 rounded-md bg-stone-200 p-1">
          <button
            type="button"
            aria-pressed={activeView === "final"}
            className={`rounded px-2 py-1 text-xs ${activeView === "final" ? "bg-white shadow-sm" : ""}`}
            onClick={() => setView("final")}
          >
            Final
          </button>
          <button
            type="button"
            aria-pressed={activeView === "raw"}
            className={`rounded px-2 py-1 text-xs ${activeView === "raw" ? "bg-white shadow-sm" : ""}`}
            onClick={() => setView("raw")}
            disabled={rawUrl === null}
          >
            Raw
          </button>
        </div>
      </div>

      {activeView === "final" && parentUrl !== null && finalUrl !== null ? (
        <div className="space-y-2">
          <div className="relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-100">
            <Image
              src={parentUrl}
              alt="Exact parent scene"
              fill
              unoptimized
              sizes="(max-width: 1024px) 100vw, 360px"
              className="object-contain"
            />
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 0 0 ${beforePercent}%)` }}
            >
              <Image
                src={finalUrl}
                alt="Final edit result"
                fill
                unoptimized
                sizes="(max-width: 1024px) 100vw, 360px"
                className="object-contain"
              />
            </div>
            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
              Parent
            </span>
            <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
              Result
            </span>
          </div>
          <label className="block text-xs text-stone-600" htmlFor={`before-after-${input.run.id}`}>
            Before / After
          </label>
          <input
            id={`before-after-${input.run.id}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={beforePercent}
            onChange={(event) => setBeforePercent(Number(event.target.value))}
            className="w-full"
          />
        </div>
      ) : activeView === "raw" && rawUrl !== null ? (
        <div className="relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-100">
          <Image
            src={rawUrl}
            alt="Raw provider output"
            fill
            unoptimized
            sizes="(max-width: 1024px) 100vw, 360px"
            className="object-contain"
          />
        </div>
      ) : (
        <p className="text-xs text-stone-500">Result image is not available.</p>
      )}

      {input.run.metrics !== null ? (
        <div className="space-y-1 text-xs text-stone-600">
          <p>
            {input.run.metrics.nativeWidth ?? "?"}×{input.run.metrics.nativeHeight ?? "?"} native ·{" "}
            {input.run.metrics.normalizedWidth ?? "?"}×{input.run.metrics.normalizedHeight ?? "?"} normalized
          </p>
          <p>
            Protected pixels: {input.run.metrics.protectedPixelCount} · raw MAE{" "}
            {input.run.metrics.rawBackgroundMae === null
              ? "n/a"
              : input.run.metrics.rawBackgroundMae.toFixed(4)}{" "}
            · final MAE{" "}
            {input.run.metrics.finalBackgroundMae === null
              ? "n/a"
              : input.run.metrics.finalBackgroundMae.toFixed(4)}{" "}
            · mismatches {input.run.metrics.protectedMismatchPixels}
          </p>
          {input.run.metrics.protectedPixelCount === 0 ? (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
              This edit had no protected pixels, so pixel preservation was not demonstrated.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-stone-500">
        The slider uses this result&apos;s exact parent. Raw output is inspectable, but only the
        final Version can be continued.
      </p>

      <button
        type="button"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50"
        onClick={() => {
          if (input.run.outputVersionId !== null) input.onContinue(input.run.outputVersionId);
        }}
        disabled={input.run.outputVersionId === null}
      >
        Continue from This Result
      </button>

      {input.run.status === "succeeded" ? (
        <EvaluationForm
          key={`${input.run.id}:${JSON.stringify(input.run.evaluation)}`}
          run={input.run}
          busy={input.busy}
          onSave={input.onEvaluation}
        />
      ) : null}

      <RunDetailPanel runId={input.run.id} commonInputHash={input.run.commonInputHash} />
    </div>
  );
}

export function EditPanel(input: {
  projectId: string | null;
  activeVersionId: string | null;
  selection: SelectionDto | null;
  selectionPending: boolean;
  paddingPx: MaskPaddingPx;
  versions: VersionDto[];
  references: ReferenceAssetDto[];
  latestRun: RunSummaryDto | null;
  busy: boolean;
  mockMode: boolean;
  imageReservationUsdMicros: number;
  comparisonReservationUsdMicros: number;
  remainingBudgetUsdMicros: number | null;
  providerAvailable: boolean;
  providerReason: string | null;
  onSubmit: (input: EditFormInput) => Promise<boolean>;
  onCompare: (input: EditFormInput) => Promise<boolean>;
  onUploadReference: (file: File) => Promise<string | null>;
  onRetry: (run: RunSummaryDto) => void;
  onContinue: (versionId: string) => void;
  onEvaluation: (runId: string, evaluation: Evaluation) => Promise<boolean>;
}) {
  const [targetLabel, setTargetLabel] = useState("selected object");
  const [instruction, setInstruction] = useState("");
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [model, setModel] = useState<EditModel>(EDIT_MODELS[0]);
  const [costAccepted, setCostAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [comparing, setComparing] = useState(false);

  const pending =
    input.latestRun !== null &&
    (input.latestRun.status === "queued" || input.latestRun.status === "running");
  const failed =
    input.latestRun !== null &&
    (input.latestRun.status === "failed" || input.latestRun.status === "needs_review");
  const ready =
    input.projectId !== null &&
    input.activeVersionId !== null &&
    input.selection !== null &&
    targetLabel.trim().length > 0 &&
    instruction.trim().length > 0 &&
    referenceIds.length <= 2 &&
    costAccepted &&
    !input.busy &&
    !input.selectionPending &&
    !submitting &&
    !comparing &&
    input.providerAvailable;

  function addReference(assetId: string): void {
    setReferenceIds((current) =>
      current.includes(assetId) || current.length >= 2 ? current : [...current, assetId],
    );
  }

  function removeReference(assetId: string): void {
    setReferenceIds((current) => current.filter((id) => id !== assetId));
  }

  function moveReference(index: number, direction: -1 | 1): void {
    setReferenceIds((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const currentId = next[index];
      const targetId = next[target];
      if (currentId === undefined || targetId === undefined) return current;
      next[index] = targetId;
      next[target] = currentId;
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (!ready) return;
    setSubmitting(true);
    try {
      const queued = await input.onSubmit({
        targetLabel: targetLabel.trim(),
        instruction: instruction.trim(),
        referenceIds,
        model,
      });
      if (queued) setCostAccepted(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function compare(): Promise<void> {
    if (!ready) return;
    setComparing(true);
    try {
      const queued = await input.onCompare({
        targetLabel: targetLabel.trim(),
        instruction: instruction.trim(),
        referenceIds,
        model,
      });
      if (queued) setCostAccepted(false);
    } finally {
      setComparing(false);
    }
  }

  if (input.activeVersionId === null) {
    return (
      <section className="rounded-xl border border-stone-300 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Edit</h2>
        <p className="mt-2 text-sm text-stone-600">Select a scene version to edit.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Edit</h2>
        <span className="text-xs text-stone-500">Padding {input.paddingPx} px</span>
      </div>

      {input.selection === null ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          Create a successful SAM selection on this version before editing.
        </p>
      ) : (
        <p className="mt-2 text-xs text-stone-500">
          Source: selection {shortId(input.selection.id)} on this version.
        </p>
      )}

      {!input.providerAvailable ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          Editing is unavailable
          {input.providerReason === "missing_key" ? ": configure OPENROUTER_API_KEY." : "."}
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        <div>
          <label className="block text-xs font-medium text-stone-600" htmlFor="edit-target-label">
            Target label
          </label>
          <input
            id="edit-target-label"
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm"
            value={targetLabel}
            maxLength={80}
            onChange={(event) => setTargetLabel(event.target.value)}
            disabled={input.busy || submitting || comparing}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-600" htmlFor="edit-instruction">
            Edit instruction
          </label>
          <textarea
            id="edit-instruction"
            className="mt-1 min-h-20 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm"
            value={instruction}
            maxLength={2000}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={input.busy || submitting || comparing}
          />
          <p className="text-right text-xs text-stone-500">{instruction.length}/2000</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-600" htmlFor="edit-model">
            Model
          </label>
          <select
            id="edit-model"
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
            value={model}
            onChange={(event) => setModel(event.target.value as EditModel)}
            disabled={input.busy || submitting || comparing}
          >
            <option value="openai/gpt-image-2.5-flare">Flare</option>
            <option value="openai/gpt-image-2.5-sunburst">Sunburst</option>
          </select>
        </div>

        <ReferencePicker
          references={input.references}
          selectedIds={referenceIds}
          busy={input.busy || submitting || comparing}
          onUpload={input.onUploadReference}
          onAdd={addReference}
          onRemove={removeReference}
          onMove={moveReference}
        />

        <label className="flex items-start gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={costAccepted}
            onChange={(event) => setCostAccepted(event.target.checked)}
            disabled={input.busy || submitting || comparing}
            className="mt-0.5"
          />
          <span>
            I confirm the estimated cost.
            {input.mockMode
              ? " Mock runs: no provider charge."
              : ` Edit: $${(input.imageReservationUsdMicros / 1_000_000).toFixed(2)}; Compare both: $${(input.comparisonReservationUsdMicros / 1_000_000).toFixed(2)}.${
                  input.remainingBudgetUsdMicros === null
                    ? ""
                    : ` Remaining budget: $${(input.remainingBudgetUsdMicros / 1_000_000).toFixed(2)}.`
                }`}
          </span>
        </label>

        <div className="grid gap-2">
          <button
            type="button"
            className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => void submit()}
            disabled={!ready}
          >
            {submitting ? "Queuing Edit..." : "Run Edit"}
          </button>
          <button
            type="button"
            className="w-full rounded-md border border-stone-400 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => void compare()}
            disabled={!ready}
          >
            {comparing ? "Queuing Comparison..." : "Compare Both"}
          </button>
        </div>

        {pending ? (
          <p className="text-xs text-stone-600">
            Edit {input.latestRun?.status}: {input.latestRun?.stage}
          </p>
        ) : null}

        {failed ? (
          <div className="space-y-2">
            <p className="text-xs text-red-700">
              {input.latestRun?.errorMessage ?? "Edit failed."}
            </p>
            {input.remainingBudgetUsdMicros !== null ? (
              <p className="text-xs text-stone-500">
                Remaining budget: ${(input.remainingBudgetUsdMicros / 1_000_000).toFixed(2)}
              </p>
            ) : null}
            {input.latestRun?.retryMode !== "none" ? (
              <button
                type="button"
                className="w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={() => input.onRetry(input.latestRun as RunSummaryDto)}
                disabled={input.busy || submitting || comparing}
              >
                {input.latestRun?.retryMode === "local"
                  ? "Retry Local Edit Processing"
                  : `Retry Edit${
                      (input.latestRun?.retryReservationUsdMicros ?? 0) > 0
                        ? ` ($${((input.latestRun?.retryReservationUsdMicros ?? 0) / 1_000_000).toFixed(4)})`
                        : ""
                    }`}
              </button>
            ) : null}
          </div>
        ) : null}

        {input.latestRun !== null &&
        input.latestRun.status === "succeeded" &&
        input.latestRun.outputVersionId !== null ? (
          <ResultCard
            key={input.latestRun.id}
            run={input.latestRun}
            versions={input.versions}
            busy={input.busy || submitting || comparing}
            onContinue={input.onContinue}
            onEvaluation={input.onEvaluation}
          />
        ) : null}
      </div>
    </section>
  );
}

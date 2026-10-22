"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { EvaluationForm } from "@/components/runs/EvaluationForm";
import { RunDetailPanel } from "@/components/runs/RunDetailPanel";
import type {
  ComparisonDetailDto,
  RunSummaryDto,
  VersionDto,
} from "@/lib/contracts/api";
import {
  COMPARISON_MODELS,
  type ComparisonModel,
  type Evaluation,
} from "@/lib/contracts/domain";
import { formatUsd, modelLabel, shortId } from "@/lib/ui/format";

function CostState(input: { run: RunSummaryDto }) {
  const { cost } = input.run;
  const pending = input.run.status === "queued" || input.run.status === "running";
  if (cost.amountUsdMicros !== null) {
    return (
      <span>
        {formatUsd(cost.amountUsdMicros)} {cost.provenance ?? "unknown"}
      </span>
    );
  }
  if (pending) {
    return <span>reserved {formatUsd(cost.budgetChargeUsdMicros)}</span>;
  }
  if (cost.budgetChargeUsdMicros > 0) {
    return (
      <span>
        amount unavailable · hold {formatUsd(cost.budgetChargeUsdMicros)} ({cost.provenance ?? "unavailable"})
      </span>
    );
  }
  return <span>amount unavailable</span>;
}

function CandidateCard(input: {
  model: ComparisonModel;
  runs: RunSummaryDto[];
  versions: VersionDto[];
  busy: boolean;
  remainingBudgetUsdMicros: number | null;
  onRetry: (run: RunSummaryDto) => void;
  onContinue: (versionId: string) => void;
  onEvaluation: (runId: string, evaluation: Evaluation) => Promise<boolean>;
}) {
  const [view, setView] = useState<"final" | "raw">("final");
  const [showBeforeAfter, setShowBeforeAfter] = useState(false);
  const [beforePercent, setBeforePercent] = useState(50);
  const latest = input.runs.at(-1);
  if (latest === undefined) return null;

  const parentVersion =
    input.versions.find((version) => version.id === latest.parentVersionId) ?? null;
  const finalVersion =
    input.versions.find((version) => version.id === latest.outputVersionId) ?? null;
  const parentUrl = parentVersion === null ? null : `/api/assets/${parentVersion.imageAssetId}`;
  const finalUrl = finalVersion === null ? null : `/api/assets/${finalVersion.imageAssetId}`;
  const rawAssetId = latest.normalizedRawAssetId ?? latest.rawAssetId;
  const rawUrl = rawAssetId === null ? null : `/api/assets/${rawAssetId}`;
  const activeView =
    view === "raw" && rawUrl !== null ? "raw" : finalUrl !== null ? "final" : rawUrl !== null ? "raw" : "none";

  return (
    <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-stone-800">
            {modelLabel(input.model)} · {latest.executionMode}
          </p>
          <p className="text-xs text-stone-500">
            {latest.status} / {latest.stage}
            {latest.providerLatencyMs !== null ? ` · ${latest.providerLatencyMs} ms` : ""}
          </p>
        </div>
        <div className="flex gap-1 rounded-md bg-stone-200 p-1">
          <button
            type="button"
            aria-pressed={activeView === "final"}
            className={`rounded px-2 py-1 text-xs ${activeView === "final" ? "bg-white shadow-sm" : ""}`}
            onClick={() => setView("final")}
            disabled={finalUrl === null}
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
            Raw (normalized for display)
          </button>
        </div>
      </div>

      {activeView === "final" && finalUrl !== null ? (
        <div className="space-y-2">
          <div className="relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-100">
            {showBeforeAfter && parentUrl !== null ? (
              <>
                <Image
                  src={parentUrl}
                  alt={`${modelLabel(input.model)} exact parent scene`}
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
                    alt={`${modelLabel(input.model)} final comparison result`}
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
              </>
            ) : (
              <Image
                src={finalUrl}
                alt={`${modelLabel(input.model)} final comparison result`}
                fill
                unoptimized
                sizes="(max-width: 1024px) 100vw, 360px"
                className="object-contain"
              />
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={showBeforeAfter}
              onChange={(event) => setShowBeforeAfter(event.target.checked)}
              disabled={parentUrl === null}
            />
            Before / After
          </label>
          {showBeforeAfter && parentUrl !== null ? (
            <input
              id={`comparison-before-after-${latest.id}`}
              aria-label="Before and after position"
              type="range"
              min={0}
              max={100}
              step={1}
              value={beforePercent}
              onChange={(event) => setBeforePercent(Number(event.target.value))}
              className="w-full"
            />
          ) : null}
        </div>
      ) : activeView === "raw" && rawUrl !== null ? (
        <div className="relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-100">
          <Image
            src={rawUrl}
            alt={`${modelLabel(input.model)} raw provider output`}
            fill
            unoptimized
            sizes="(max-width: 1024px) 100vw, 360px"
            className="object-contain"
          />
        </div>
      ) : (
        <p className="text-xs text-stone-500">Result image is not available.</p>
      )}

      <dl className="space-y-1 text-xs text-stone-600">
        <div className="flex justify-between gap-2">
          <dt>Model</dt>
          <dd className="text-right font-medium">
            {latest.model} · {latest.executionMode}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Cost</dt>
          <dd className="text-right font-medium">
            <CostState run={latest} />
          </dd>
        </div>
        {latest.metrics !== null ? (
          <>
            <div className="flex justify-between gap-2">
              <dt>Native / normalized</dt>
              <dd className="text-right font-medium">
                {latest.metrics.nativeWidth ?? "?"}×{latest.metrics.nativeHeight ?? "?"} /{" "}
                {latest.metrics.normalizedWidth ?? "?"}×{latest.metrics.normalizedHeight ?? "?"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Protected pixels</dt>
              <dd className="text-right font-medium">
                {latest.metrics.protectedPixelCount} · raw MAE{" "}
                {latest.metrics.rawBackgroundMae === null
                  ? "n/a"
                  : latest.metrics.rawBackgroundMae.toFixed(4)}{" "}
                · final MAE{" "}
                {latest.metrics.finalBackgroundMae === null
                  ? "n/a"
                  : latest.metrics.finalBackgroundMae.toFixed(4)}{" "}
                · mismatches {latest.metrics.protectedMismatchPixels}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      {latest.metrics !== null && latest.metrics.protectedPixelCount === 0 ? (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          No protected pixels, so pixel preservation was not demonstrated for this candidate.
        </p>
      ) : null}

      {latest.errorMessage !== null ? (
        <p className="text-xs text-red-700">{latest.errorMessage}</p>
      ) : null}

      {latest.retryMode !== "none" ? (
        <>
          {input.remainingBudgetUsdMicros !== null ? (
            <p className="text-xs text-stone-500">
              Remaining budget: ${(input.remainingBudgetUsdMicros / 1_000_000).toFixed(2)}
            </p>
          ) : null}
          <button
            type="button"
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => input.onRetry(latest)}
            disabled={input.busy}
          >
            {latest.retryMode === "local"
              ? `Retry ${modelLabel(input.model)} Local Processing`
              : `Retry ${modelLabel(input.model)}${
                  latest.retryReservationUsdMicros > 0
                    ? ` (${formatUsd(latest.retryReservationUsdMicros)})`
                    : ""
                }`}
          </button>
        </>
      ) : null}

      <button
        type="button"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium disabled:opacity-50"
        onClick={() => {
          if (latest.outputVersionId !== null) input.onContinue(latest.outputVersionId);
        }}
        disabled={latest.outputVersionId === null}
      >
        Continue from {modelLabel(input.model)}
      </button>

      {latest.status === "succeeded" ? (
        <EvaluationForm
          key={`evaluation-${latest.id}-${JSON.stringify(latest.evaluation)}`}
          run={latest}
          busy={input.busy}
          onSave={input.onEvaluation}
        />
      ) : null}

      <RunDetailPanel
        key={`detail-${latest.id}`}
        runId={latest.id}
        commonInputHash={latest.commonInputHash}
      />
    </div>
  );
}

export function ComparisonPanel(input: {
  groupId: string;
  runs: RunSummaryDto[];
  versions: VersionDto[];
  busy: boolean;
  remainingBudgetUsdMicros: number | null;
  onRetry: (run: RunSummaryDto) => void;
  onContinue: (versionId: string) => void;
  onEvaluation: (runId: string, evaluation: Evaluation) => Promise<boolean>;
}) {
  const [detail, setDetail] = useState<ComparisonDetailDto | null>(null);
  const [detailSignature, setDetailSignature] = useState<string | null>(null);
  const [costError, setCostError] = useState<string | null>(null);

  const signature = input.runs
    .map(
      (run) =>
        `${run.id}:${run.status}:${run.cost.amountUsdMicros}:${run.cost.budgetChargeUsdMicros}:${run.cost.outcome}:${JSON.stringify(run.evaluation)}`,
    )
    .join("|");

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/comparisons/${input.groupId}`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as
          | ComparisonDetailDto
          | { error?: { message?: string } }
          | null;
        if (!response.ok) {
          if (!cancelled) {
            setCostError(
              body !== null && "error" in body && body.error?.message !== undefined
                ? body.error.message
                : `Comparison summary failed (${response.status}).`,
            );
          }
          return;
        }
        if (!cancelled) {
          setDetail(body as ComparisonDetailDto);
          setDetailSignature(signature);
          setCostError(null);
        }
      } catch {
        if (!cancelled) setCostError("Comparison cost summary is unavailable.");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [input.groupId, signature]);

  const freshDetail = detail !== null && detailSignature === signature ? detail : null;
  const groupRuns = freshDetail?.runs ?? input.runs;
  const attempts = [...groupRuns].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const candidates = COMPARISON_MODELS.map((model) => ({
    model,
    runs: groupRuns.filter((run) => run.model === model),
  }));
  const initialHashes = candidates
    .map((candidate) => candidate.runs[0]?.commonInputHash ?? null)
    .filter((hash): hash is string => hash !== null);
  const sharedInputIdentical =
    initialHashes.length === COMPARISON_MODELS.length &&
    new Set(initialHashes).size === 1;
  const sharedSelection = freshDetail?.sharedSelectionCost ?? null;
  const candidateCost = freshDetail?.candidateCost ?? null;

  return (
    <section className="rounded-xl border border-stone-300 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Comparison</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            sharedInputIdentical
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-900"
          }`}
        >
          {sharedInputIdentical ? "Frozen input identical" : "Frozen input not verified"}
        </span>
      </div>

      <div className="mt-2 space-y-1 text-xs text-stone-600">
        <p>
          Shared mask (SAM):{" "}
          {sharedSelection === null
            ? "unavailable"
            : `${formatUsd(sharedSelection.amountUsdMicros)}${
                sharedSelection.provenance === null ? "" : ` ${sharedSelection.provenance}`
              }`}
          . Counted once, not per candidate.
        </p>
        {candidateCost !== null ? (
          <>
            <p>
              Candidate cost: {formatUsd(candidateCost.knownUsdMicros)} known
              {candidateCost.unknownAmountRuns > 0
                ? ` · ${candidateCost.unknownAmountRuns} unknown`
                : ""}
              {candidateCost.pendingRuns > 0 ? ` · ${candidateCost.pendingRuns} pending` : ""}
            </p>
            {candidateCost.byModel.map((modelCost) => (
              <p key={modelCost.model}>
                {modelLabel(modelCost.model)}: {formatUsd(modelCost.knownUsdMicros)} known
                {modelCost.unknownAmountRuns > 0
                  ? ` · ${modelCost.unknownAmountRuns} unknown`
                  : ""}
                {modelCost.pendingRuns > 0 ? ` · ${modelCost.pendingRuns} pending` : ""}
                {modelCost.runIds.length > 1 ? ` · ${modelCost.runIds.length} attempts` : ""}
              </p>
            ))}
          </>
        ) : null}
        {costError !== null ? <p className="text-amber-800">{costError}</p> : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {candidates.map((candidate) => (
          <CandidateCard
            key={candidate.model}
            model={candidate.model}
            runs={candidate.runs}
            versions={input.versions}
            busy={input.busy}
            remainingBudgetUsdMicros={input.remainingBudgetUsdMicros}
            onRetry={input.onRetry}
            onContinue={input.onContinue}
            onEvaluation={input.onEvaluation}
          />
        ))}
      </div>

      <details className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-2">
        <summary className="cursor-pointer text-xs font-medium text-stone-700">
          Attempt history ({attempts.length})
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-stone-600">
          {attempts.map((run, index) => (
            <li key={run.id} className="flex flex-wrap justify-between gap-2">
              <span>
                {index + 1}. {modelLabel(run.model)} · {run.status}
                {run.retryOfRunId !== null ? ` · retry of ${shortId(run.retryOfRunId)}` : ""}
              </span>
              <span>
                {run.cost.amountUsdMicros === null
                  ? run.cost.outcome === "unknown"
                    ? "amount unavailable"
                    : "no settled amount"
                  : `${formatUsd(run.cost.amountUsdMicros)} ${run.cost.provenance ?? ""}`}
                {run.errorCode !== null ? ` · ${run.errorCode}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

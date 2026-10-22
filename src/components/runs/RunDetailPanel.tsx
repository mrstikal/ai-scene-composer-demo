"use client";

import { useState } from "react";

import type { RunDetailDto } from "@/lib/contracts/api";
import { formatUsd } from "@/lib/ui/format";

function Field(input: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-stone-500">{input.label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-stone-800">{input.children}</dd>
    </div>
  );
}

function RunInputDetail(input: { detail: RunDetailDto }) {
  const { input: frozen } = input.detail;
  if (frozen === null) {
    return <p className="text-xs text-stone-500">Frozen input is unavailable.</p>;
  }

  if (frozen.kind === "generate") {
    return (
      <dl className="space-y-1 text-xs">
        <Field label="Mode">{frozen.mode}</Field>
        <Field label="Preset">{frozen.presetId ?? "none"}</Field>
        <Field label="Model">{frozen.model}</Field>
        <Field label="Pricing">{frozen.pricingVersion}</Field>
        <Field label="Capability">{frozen.capabilityVersion}</Field>
        <Field label="Reservation">{formatUsd(frozen.reservationUsdMicros)}</Field>
        <div>
          <dt className="text-stone-500">Prompt</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-stone-700">
            {frozen.prompt}
          </dd>
        </div>
      </dl>
    );
  }

  if (frozen.kind === "segment") {
    return (
      <dl className="space-y-1 text-xs">
        <Field label="Source version">{frozen.sourceVersionId}</Field>
        <Field label="Source asset">{frozen.sourceAssetId}</Field>
        <Field label="Source SHA-256">{frozen.sourceSha256}</Field>
        <Field label="Dimensions">
          {frozen.width} x {frozen.height}
        </Field>
        <Field label="Positive points">
          {frozen.positivePoints.map((point) => `(${point.x},${point.y})`).join(", ")}
        </Field>
        <Field label="Negative points">
          {frozen.negativePoints.length === 0
            ? "none"
            : frozen.negativePoints.map((point) => `(${point.x},${point.y})`).join(", ")}
        </Field>
        <Field label="Model">{frozen.model}</Field>
        <Field label="Parser">{frozen.parserVersion}</Field>
        <Field label="Prompt version">{frozen.promptVersion}</Field>
        <Field label="Pricing">{frozen.pricingVersion}</Field>
        <Field label="Reservation">{formatUsd(frozen.reservationUsdMicros)}</Field>
        <div>
          <dt className="text-stone-500">SAM prompt</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-stone-700">
            {frozen.prompt}
          </dd>
        </div>
      </dl>
    );
  }

  return (
    <dl className="space-y-1 text-xs">
      <Field label="Parent version">{frozen.parentVersionId}</Field>
      <Field label="Source asset">{frozen.sourceAssetId}</Field>
      <Field label="Source SHA-256">{frozen.sourceSha256}</Field>
      <Field label="Selection">{frozen.selectionId}</Field>
      <Field label="Padding / feather">
        {frozen.paddingPx} px / {frozen.featherPx} px
      </Field>
      <Field label="Region bbox">
        {frozen.regionBoundingBox.left},{frozen.regionBoundingBox.top} to{" "}
        {frozen.regionBoundingBox.right},{frozen.regionBoundingBox.bottom}
      </Field>
      <Field label="Region percent">
        {frozen.regionPercentages.left.toFixed(1)}, {frozen.regionPercentages.top.toFixed(1)} to{" "}
        {frozen.regionPercentages.right.toFixed(1)}, {frozen.regionPercentages.bottom.toFixed(1)}
      </Field>
      <Field label="Target">{frozen.targetLabel}</Field>
      <Field label="Model">{frozen.model}</Field>
      <Field label="References">
        {frozen.referenceAssetIds.length === 0
          ? "none"
          : frozen.referenceAssetIds
              .map((assetId, index) => `${index + 2}: ${assetId} (${frozen.referenceSha256[index]})`)
              .join("; ")}
      </Field>
      <Field label="Mask pipeline">{frozen.maskPipelineVersion}</Field>
      <Field label="Normalization">{frozen.normalizationVersion}</Field>
      <Field label="Prompt version">{frozen.promptVersion}</Field>
      <Field label="Pricing">{frozen.pricingVersion}</Field>
      <Field label="Capability">{frozen.capabilityVersion}</Field>
      <Field label="Reservation">{formatUsd(frozen.reservationUsdMicros)}</Field>
      <div>
        <dt className="text-stone-500">Instruction</dt>
        <dd className="mt-1 whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-stone-700">
          {frozen.instruction}
        </dd>
      </div>
      <div>
        <dt className="text-stone-500">Compiled prompt</dt>
        <dd className="mt-1 whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-stone-700">
          {frozen.prompt}
        </dd>
      </div>
      <div>
        <dt className="text-stone-500">Transport options</dt>
        <dd className="mt-1 whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-stone-700">
          {JSON.stringify(frozen.transportOptions)}
        </dd>
      </div>
    </dl>
  );
}

export function RunDetailPanel(input: { runId: string; commonInputHash: string | null }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail !== null) return;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${input.runId}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | RunDetailDto
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(
          body !== null && "error" in body && body.error?.message !== undefined
            ? body.error.message
            : `Request failed (${response.status}).`,
        );
        return;
      }
      setDetail(body as RunDetailDto);
    } catch {
      setError("Could not load the frozen request.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium"
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        {open ? "Hide Request Details" : "Inspect Request"}
      </button>
      {open ? (
        <div className="space-y-2 rounded-md border border-stone-200 bg-stone-50 p-2">
          {input.commonInputHash !== null ? (
            <p className="break-all text-xs text-stone-500">
              Common input hash: {input.commonInputHash}
            </p>
          ) : null}
          {loading ? <p className="text-xs text-stone-500">Loading...</p> : null}
          {error !== null ? <p className="text-xs text-red-700">{error}</p> : null}
          {detail !== null ? (
            <>
              <RunInputDetail detail={detail} />
              <div className="border-t border-stone-200 pt-2">
                <p className="text-xs font-medium text-stone-700">Accounting</p>
                <dl className="mt-1 space-y-1 text-xs">
                  <Field label="Usage outcome">{detail.usage?.outcome ?? "none"}</Field>
                  <Field label="Amount">{formatUsd(detail.usage?.amountUsdMicros ?? null)}</Field>
                  <Field label="Provenance">{detail.usage?.costProvenance ?? "none"}</Field>
                  <Field label="Provider request">
                    {detail.usage?.providerRequestId ?? "none"}
                  </Field>
                  <Field label="Provider latency">
                    {detail.usage?.elapsedMs === null || detail.usage?.elapsedMs === undefined
                      ? "not measured"
                      : `${detail.usage.elapsedMs} ms`}
                  </Field>
                </dl>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

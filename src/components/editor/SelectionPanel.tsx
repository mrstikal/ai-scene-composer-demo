"use client";

import type { RunSummaryDto, SelectionDto } from "@/lib/contracts/api";
import type { MaskPaddingPx, Point } from "@/lib/contracts/domain";
import { shortId } from "@/lib/ui/format";

function pointLabel(point: Point): string {
  return `(${point.x}, ${point.y})`;
}

export function SelectionPanel(input: {
  activeVersionId: string | null;
  selections: SelectionDto[];
  selection: SelectionDto | null;
  pendingRun: RunSummaryDto | null;
  submitting: boolean;
  latestRun: RunSummaryDto | null;
  mode: "positive" | "negative";
  onModeChange: (mode: "positive" | "negative") => void;
  positivePoints: Point[];
  negativePoints: Point[];
  paddingPx: MaskPaddingPx;
  onPaddingChange: (padding: MaskPaddingPx) => void;
  maskVisible: boolean;
  onMaskVisibleChange: (visible: boolean) => void;
  maskOpacity: number;
  onMaskOpacityChange: (opacity: number) => void;
  allowedVisible: boolean;
  onAllowedVisibleChange: (visible: boolean) => void;
  onSelectSaved: (selectionId: string | null) => void;
  onRetry: (run: RunSummaryDto) => void;
  retryDisabled: boolean;
  providerAvailable: boolean;
  providerReason: string | null;
  mockMode: boolean;
  segmentationReservationUsdMicros: number;
}) {
  if (input.activeVersionId === null) {
    return (
      <section className="rounded-xl border border-stone-300 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Selection</h2>
        <p className="mt-2 text-sm text-stone-600">Select a scene version to start a SAM selection.</p>
      </section>
    );
  }

  const variant =
    input.selection === null
      ? null
      : input.selection.regions.variants[String(input.paddingPx) as "16" | "32"];
  const positivePoints = input.positivePoints;
  const negativePoints = input.negativePoints;
  const positivePoint = positivePoints[0] ?? null;
  const pending = input.pendingRun !== null || input.submitting;
  const failed =
    input.latestRun !== null &&
    (input.latestRun.status === "failed" || input.latestRun.status === "needs_review");

  return (
    <section className="rounded-xl border border-stone-300 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Selection</h2>
        <span className="text-xs text-stone-500">SAM 3.1</span>
      </div>

      <p className="mt-2 text-xs text-stone-600">
        {input.mockMode
          ? "Mock selection: no provider charge."
          : input.segmentationReservationUsdMicros > 0
            ? `SAM reservation: USD ${(input.segmentationReservationUsdMicros / 1_000_000).toFixed(6)} per click.`
            : "No provider charge in SAM fixture mode."}
      </p>

      {!input.providerAvailable ? (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          SAM selection is unavailable
          {input.providerReason === "missing_key"
            ? ": configure META_MODEL_API_KEY."
            : input.providerReason === "fixture_missing"
              ? ": no authentic capture matches this source."
              : "."}
        </p>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
        <button
          type="button"
          aria-pressed={input.mode === "positive"}
          className={`rounded-md px-2 py-1.5 text-sm ${
            input.mode === "positive" ? "bg-white shadow-sm" : "text-stone-600"
          }`}
          onClick={() => input.onModeChange("positive")}
          disabled={pending || !input.providerAvailable}
        >
          Positive point
        </button>
        <button
          type="button"
          aria-pressed={input.mode === "negative"}
          className={`rounded-md px-2 py-1.5 text-sm ${
            input.mode === "negative" ? "bg-white shadow-sm" : "text-stone-600"
          }`}
          onClick={() => input.onModeChange("negative")}
          disabled={pending || positivePoint === null || !input.providerAvailable}
        >
          Negative point
        </button>
      </div>

      <p className="mt-2 text-xs text-stone-500">
        {input.mode === "negative"
          ? "Click or Alt/Option-click the object part to exclude. All positive and negative points are sent together."
          : "Click replaces the selection with one positive point. Shift-click adds a positive point; Alt/Option-click subtracts a negative point. Up to 8 points per label; every click runs SAM."}
      </p>

      {positivePoints.length > 0 || negativePoints.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
          {positivePoints.map((point, index) => (
            <span
              key={`positive-${point.x}-${point.y}-${index}`}
              className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-900"
            >
              + {pointLabel(point)}
            </span>
          ))}
          {negativePoints.map((point, index) => (
            <span
              key={`negative-${point.x}-${point.y}-${index}`}
              className="rounded-full bg-red-100 px-2 py-0.5 text-red-900"
            >
              − {pointLabel(point)}
            </span>
          ))}
        </div>
      ) : null}

      {pending ? (
        <p className="mt-3 text-xs text-stone-600">
          Selecting… {input.pendingRun?.status ?? "submitting"}
          {input.pendingRun !== null ? ` / ${input.pendingRun.stage}` : ""}
        </p>
      ) : null}

      {failed ? (
        <p className="mt-3 text-xs text-red-700">
          {input.latestRun?.errorMessage ?? "The last selection failed."}
        </p>
      ) : null}

      {input.latestRun !== null && input.latestRun.status === "succeeded" ? (
        <p className="mt-3 text-xs text-stone-500">
          Last selection succeeded · USD{" "}
          {(input.latestRun.cost.budgetChargeUsdMicros / 1_000_000).toFixed(6)}
        </p>
      ) : null}

      {input.latestRun !== null && input.latestRun.retryMode !== "none" ? (
        <button
          type="button"
          className="mt-3 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-medium disabled:opacity-50"
          onClick={() => input.onRetry(input.latestRun as RunSummaryDto)}
          disabled={input.retryDisabled}
        >
          {input.latestRun.retryMode === "local"
            ? "Retry Local Selection Processing"
            : `Retry SAM Selection${
                input.latestRun.retryReservationUsdMicros > 0
                  ? ` ($${(input.latestRun.retryReservationUsdMicros / 1_000_000).toFixed(4)})`
                  : ""
              }`}
        </button>
      ) : null}

      <div className="mt-4 space-y-3 border-t border-stone-200 pt-3">
        <div>
          <label className="block text-xs font-medium text-stone-600" htmlFor="saved-selection">
            Saved selection
          </label>
          <select
            id="saved-selection"
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
            value={input.selection?.id ?? ""}
            onChange={(event) =>
              input.onSelectSaved(event.target.value.length === 0 ? null : event.target.value)
            }
            disabled={pending || input.selections.length === 0}
          >
            <option value="">Latest selection</option>
            {input.selections.map((selection) => (
              <option key={selection.id} value={selection.id}>
                {shortId(selection.id)} · +{selection.positivePoints.length}
                {selection.negativePoints.length > 0
                  ? ` −${selection.negativePoints.length}`
                  : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-stone-500">
            Saved selections are immutable and can only be reused on their own version.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-stone-600">Padding</span>
          <div className="flex gap-1">
            {([16, 32] as const).map((padding) => (
              <button
                key={padding}
                type="button"
                aria-pressed={input.paddingPx === padding}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  input.paddingPx === padding
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-300 bg-white text-stone-700"
                }`}
                onClick={() => input.onPaddingChange(padding)}
              >
                Padding {padding} px
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={input.maskVisible}
            onChange={(event) => input.onMaskVisibleChange(event.target.checked)}
          />
          Show SAM mask
        </label>

        <div>
          <label className="block text-xs font-medium text-stone-600" htmlFor="mask-opacity">
            Mask opacity
          </label>
          <input
            id="mask-opacity"
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={input.maskOpacity}
            onChange={(event) => input.onMaskOpacityChange(Number(event.target.value))}
            className="mt-1 w-full"
          />
          <p className="text-right text-xs text-stone-500">{input.maskOpacity.toFixed(2)}</p>
        </div>

        <label className="flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={input.allowedVisible}
            onChange={(event) => input.onAllowedVisibleChange(event.target.checked)}
          />
          Show allowed region
        </label>

        {input.selection !== null && variant !== null ? (
          <div className="space-y-2 rounded-md border border-stone-200 bg-stone-50 p-2">
            <p className="text-xs font-medium text-stone-700">
              Selection {shortId(input.selection.id)}
            </p>
            <p className="text-xs text-stone-600">
              Allowed region: left {variant.percentages.left.toFixed(1)}% · top{" "}
              {variant.percentages.top.toFixed(1)}% · right{" "}
              {variant.percentages.right.toFixed(1)}% · bottom{" "}
              {variant.percentages.bottom.toFixed(1)}%
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <a
                className="underline decoration-stone-400 underline-offset-2"
                href={`/api/assets/${input.selection.binaryMaskAssetId}`}
                target="_blank"
                rel="noreferrer"
              >
                View mask
              </a>
              <a
                className="underline decoration-stone-400 underline-offset-2"
                href={`/api/assets/${variant.allowedMaskAssetId}`}
                target="_blank"
                rel="noreferrer"
              >
                View allowed region
              </a>
              <a
                className="underline decoration-stone-400 underline-offset-2"
                href={`/api/assets/${variant.blendMaskAssetId}`}
                target="_blank"
                rel="noreferrer"
              >
                View blend alpha
              </a>
            </div>
          </div>
        ) : (
          <p className="text-xs text-stone-500">
            {pending ? "The mask will appear when the worker finishes." : "No saved selection yet."}
          </p>
        )}
      </div>
    </section>
  );
}

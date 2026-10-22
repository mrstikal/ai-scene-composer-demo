"use client";

import type { CostBucketsDto, ProjectCostsDto } from "@/lib/contracts/api";
import { formatUsd } from "@/lib/ui/format";

function formatLimit(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function BucketRows(input: { buckets: CostBucketsDto }) {
  return (
    <dl className="space-y-1 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-stone-500">Provider-reported</dt>
        <dd className="font-medium">{formatUsd(input.buckets.providerUsdMicros)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-stone-500">Calculated</dt>
        <dd className="font-medium">{formatUsd(input.buckets.calculatedUsdMicros)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-stone-500">Estimated</dt>
        <dd className="font-medium">{formatUsd(input.buckets.estimatedUsdMicros)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-stone-500">Active reservations</dt>
        <dd className="font-medium">{formatUsd(input.buckets.activeReservationUsdMicros)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-stone-500">Unknown-charge holds</dt>
        <dd className="font-medium">{formatUsd(input.buckets.unknownHoldUsdMicros)}</dd>
      </div>
    </dl>
  );
}

export function CostSummary(input: { costs: ProjectCostsDto | null; error: string | null }) {
  if (input.costs === null) {
    return (
      <section className="rounded-xl border border-stone-300 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Costs</h2>
        <p className="mt-2 text-xs text-stone-500">
          {input.error ?? "Loading costs..."}
        </p>
      </section>
    );
  }

  const { totals } = input.costs;
  const recentEvents = [...input.costs.events].reverse().slice(0, 12);

  return (
    <section className="rounded-xl border border-stone-300 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Costs</h2>
      {input.error !== null ? (
        <p role="status" className="mt-2 text-xs text-amber-800">
          {input.error} Showing the last known financial state.
        </p>
      ) : null}
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">Budget limit</dt>
          <dd className="font-medium">{formatLimit(totals.budgetLimitUsdMicros)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">Commitment</dt>
          <dd className="font-medium">{formatUsd(totals.commitmentUsdMicros)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-stone-500">Remaining</dt>
          <dd className="font-medium">{formatUsd(totals.remainingUsdMicros)}</dd>
        </div>
        {totals.overrunUsdMicros > 0 ? (
          <div className="flex justify-between gap-2 text-red-700">
            <dt>Overrun</dt>
            <dd className="font-medium">{formatUsd(totals.overrunUsdMicros)}</dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-3 border-t border-stone-200 pt-2">
        <p className="text-xs font-medium text-stone-700">Allocation</p>
        <div className="mt-1">
          <BucketRows buckets={totals} />
        </div>
      </div>

      {input.costs.byOperation.length > 0 ? (
        <div className="mt-3 border-t border-stone-200 pt-2">
          <p className="text-xs font-medium text-stone-700">By operation</p>
          <ul className="mt-1 space-y-2">
            {input.costs.byOperation.map((group) => (
              <li key={group.operation}>
                <p className="text-xs font-medium text-stone-600">{group.operation}</p>
                <BucketRows buckets={group} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {input.costs.byModel.length > 0 ? (
        <div className="mt-3 border-t border-stone-200 pt-2">
          <p className="text-xs font-medium text-stone-700">By model</p>
          <ul className="mt-1 space-y-2">
            {input.costs.byModel.map((group) => (
              <li key={group.model}>
                <p className="break-words text-xs font-medium text-stone-600">{group.model}</p>
                <BucketRows buckets={group} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {recentEvents.length > 0 ? (
        <div className="mt-3 border-t border-stone-200 pt-2">
          <p className="text-xs font-medium text-stone-700">Recent usage events</p>
          <ul className="mt-1 space-y-1 text-xs text-stone-600">
            {recentEvents.map((event) => (
              <li key={event.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {event.operation} · {event.model} · {event.outcome}
                </span>
                <span>
                  {formatUsd(event.amountUsdMicros)} {event.costProvenance}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

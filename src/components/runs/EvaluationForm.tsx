"use client";

import { useState } from "react";

import type { RunSummaryDto } from "@/lib/contracts/api";
import type { Evaluation } from "@/lib/contracts/domain";

const SCORE_OPTIONS = [1, 2, 3, 4, 5] as const;

function ScoreSelect(input: {
  id: string;
  label: string;
  value: number | "";
  onChange: (value: number | "") => void;
  disabled: boolean;
}) {
  return (
    <label className="block text-xs text-stone-600" htmlFor={input.id}>
      {input.label}
      <select
        id={input.id}
        className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
        value={input.value === "" ? "" : String(input.value)}
        onChange={(event) =>
          input.onChange(event.target.value === "" ? "" : Number(event.target.value))
        }
        disabled={input.disabled}
      >
        <option value="">Select</option>
        {SCORE_OPTIONS.map((score) => (
          <option key={score} value={score}>
            {score}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EvaluationForm(input: {
  run: RunSummaryDto;
  busy: boolean;
  onSave: (runId: string, evaluation: Evaluation) => Promise<boolean>;
}) {
  const hasReferences = (input.run.editInput?.referenceAssetIds.length ?? 0) > 0;
  const [boundaryArtifacts, setBoundaryArtifacts] = useState<number | "">(
    input.run.evaluation?.boundaryArtifacts ?? "",
  );
  const [promptAdherence, setPromptAdherence] = useState<number | "">(
    input.run.evaluation?.promptAdherence ?? "",
  );
  const [referenceFidelity, setReferenceFidelity] = useState<number | null>(
    hasReferences ? input.run.evaluation?.referenceFidelity ?? null : null,
  );
  const [plausibility, setPlausibility] = useState<number | "">(
    input.run.evaluation?.plausibility ?? "",
  );
  const [notes, setNotes] = useState(input.run.evaluation?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const ready =
    boundaryArtifacts !== "" &&
    promptAdherence !== "" &&
    plausibility !== "" &&
    !input.busy &&
    !saving;

  async function save(): Promise<void> {
    if (!ready) return;
    setSaving(true);
    setSaved(false);
    try {
      const ok = await input.onSave(input.run.id, {
        boundaryArtifacts: boundaryArtifacts as number,
        promptAdherence: promptAdherence as number,
        referenceFidelity: hasReferences ? referenceFidelity : null,
        plausibility: plausibility as number,
        notes,
      });
      if (ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-stone-200 bg-white p-2">
      <p className="text-xs font-medium text-stone-700">Manual evaluation (1 = poor, 5 = best)</p>
      <div className="grid grid-cols-2 gap-2">
        <ScoreSelect
          id={`boundary-${input.run.id}`}
          label="Boundary artifacts"
          value={boundaryArtifacts}
          onChange={setBoundaryArtifacts}
          disabled={input.busy || saving}
        />
        <ScoreSelect
          id={`adherence-${input.run.id}`}
          label="Prompt adherence"
          value={promptAdherence}
          onChange={setPromptAdherence}
          disabled={input.busy || saving}
        />
        <label className="block text-xs text-stone-600" htmlFor={`fidelity-${input.run.id}`}>
          Reference fidelity
          <select
            id={`fidelity-${input.run.id}`}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
            value={referenceFidelity === null ? "unscored" : String(referenceFidelity)}
            onChange={(event) =>
              setReferenceFidelity(
                event.target.value === "unscored" ? null : Number(event.target.value),
              )
            }
            disabled={input.busy || saving || !hasReferences}
          >
            <option value="unscored">Not scored</option>
            {SCORE_OPTIONS.map((score) => (
              <option key={score} value={score}>
                {score}
              </option>
            ))}
          </select>
        </label>
        <ScoreSelect
          id={`plausibility-${input.run.id}`}
          label="Plausibility"
          value={plausibility}
          onChange={setPlausibility}
          disabled={input.busy || saving}
        />
      </div>
      {!hasReferences ? (
        <p className="text-xs text-stone-500">
          Reference fidelity stays unscored because this edit had no references.
        </p>
      ) : null}
      <label className="block text-xs text-stone-600" htmlFor={`notes-${input.run.id}`}>
        Notes
        <textarea
          id={`notes-${input.run.id}`}
          className="mt-1 min-h-16 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm"
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          disabled={input.busy || saving}
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="rounded-md border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          onClick={() => void save()}
          disabled={!ready}
        >
          {saving ? "Saving..." : input.run.evaluation === null ? "Save Evaluation" : "Update Evaluation"}
        </button>
        {saved ? <span className="text-xs text-emerald-700">Saved</span> : null}
      </div>
    </div>
  );
}

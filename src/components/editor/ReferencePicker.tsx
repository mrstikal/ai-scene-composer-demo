"use client";

import Image from "next/image";
import { useRef, useState } from "react";

import type { ReferenceAssetDto } from "@/lib/contracts/api";

export function ReferencePicker(input: {
  references: ReferenceAssetDto[];
  selectedIds: string[];
  busy: boolean;
  onUpload: (file: File) => Promise<string | null>;
  onAdd: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selected = input.selectedIds
    .map((id) => input.references.find((reference) => reference.id === id) ?? null)
    .filter((reference): reference is ReferenceAssetDto => reference !== null);
  const available = input.references.filter(
    (reference) => !input.selectedIds.includes(reference.id),
  );

  async function upload(): Promise<void> {
    if (file === null) return;
    setUploading(true);
    try {
      const assetId = await input.onUpload(file);
      if (assetId !== null) {
        setFile(null);
        if (fileInputRef.current !== null) fileInputRef.current.value = "";
        if (input.selectedIds.length < 2) input.onAdd(assetId);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-stone-600">References</span>
        <span className="text-xs text-stone-500">{input.selectedIds.length}/2</span>
      </div>

      {selected.length === 0 ? (
        <p className="text-xs text-stone-500">
          No references selected. The edit uses only the source scene.
        </p>
      ) : (
        <ul className="space-y-1">
          {selected.map((reference, index) => (
            <li
              key={reference.id}
              className="flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50 p-2"
            >
              <Image
                src={`/api/assets/${reference.id}`}
                alt={`Reference ${index + 1}`}
                width={40}
                height={40}
                unoptimized
                className="h-10 w-10 rounded object-cover"
              />
              <span className="flex-1 text-xs text-stone-700">Image {index + 2}</span>
              <button
                type="button"
                className="rounded border border-stone-300 px-1.5 py-0.5 text-xs disabled:opacity-40"
                onClick={() => input.onMove(index, -1)}
                disabled={index === 0 || input.busy}
                aria-label={`Move Image ${index + 2} left`}
              >
                ←
              </button>
              <button
                type="button"
                className="rounded border border-stone-300 px-1.5 py-0.5 text-xs disabled:opacity-40"
                onClick={() => input.onMove(index, 1)}
                disabled={index === selected.length - 1 || input.busy}
                aria-label={`Move Image ${index + 2} right`}
              >
                →
              </button>
              <button
                type="button"
                className="rounded border border-stone-300 px-1.5 py-0.5 text-xs disabled:opacity-40"
                onClick={() => input.onRemove(reference.id)}
                disabled={input.busy}
                aria-label={`Remove Image ${index + 2}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {available.map((reference) => (
            <button
              key={reference.id}
              type="button"
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs disabled:opacity-40"
              onClick={() => input.onAdd(reference.id)}
              disabled={input.busy || input.selectedIds.length >= 2}
            >
              Add {reference.id.slice(0, 6)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          className="block min-w-0 flex-1 text-xs"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={input.busy || uploading}
          aria-label="Reference image file"
        />
        <button
          type="button"
          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium disabled:opacity-40"
          onClick={() => void upload()}
          disabled={input.busy || uploading || file === null}
        >
          Upload reference
        </button>
      </div>
    </div>
  );
}

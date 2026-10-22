"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import type { Point } from "@/lib/contracts/domain";
import { mapPointerToCanonical } from "@/lib/images/coordinates";
import { MaskOverlay } from "./MaskOverlay";

interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function SceneCanvas(input: {
  imageAssetId: string;
  alt: string;
  maskAssetId: string | null;
  allowedMaskAssetId: string | null;
  maskVisible: boolean;
  maskOpacity: number;
  allowedVisible: boolean;
  disabled: boolean;
  positivePoint: Point | null;
  negativePoint: Point | null;
  onSelect: (point: Point) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canceledRef = useRef(false);
  const [displayRect, setDisplayRect] = useState<DisplayRect | null>(null);

  useEffect(() => {
    const element = frameRef.current;
    if (element === null) return;

    function measure(): void {
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height);
      setDisplayRect({
        left: (rect.width - size) / 2,
        top: (rect.height - size) / 2,
        width: size,
        height: size,
      });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (input.disabled) return;
    if (canceledRef.current) {
      canceledRef.current = false;
      return;
    }
    const native = event.nativeEvent;
    if (!native.isPrimary || native.button !== 0) return;

    const element = frameRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const point = mapPointerToCanonical({
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      clientX: native.clientX,
      clientY: native.clientY,
    });
    if (point !== null) input.onSelect(point);
  }

  const marker = (point: Point | null, tone: string, label: string) => {
    if (point === null || displayRect === null) return null;
    return (
      <span
        key={label}
        aria-label={label}
        className={`pointer-events-none absolute z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ${tone}`}
        style={{
          left: displayRect.left + (point.x / 1024) * displayRect.width,
          top: displayRect.top + (point.y / 1024) * displayRect.height,
        }}
      />
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-stone-200 bg-stone-100 p-2">
      <div className="relative mx-auto aspect-square max-h-[70vh] w-full overflow-hidden rounded-md bg-stone-200">
        <div
          ref={frameRef}
          role="group"
          aria-label="Scene selection canvas"
          aria-disabled={input.disabled}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            canceledRef.current = true;
          }}
          className={`relative h-full w-full touch-none select-none ${
            input.disabled ? "cursor-not-allowed" : "cursor-crosshair"
          }`}
        >
          <Image
            src={`/api/assets/${input.imageAssetId}`}
            alt={input.alt}
            fill
            unoptimized
            loading="eager"
            sizes="(max-width: 1024px) 100vw, 720px"
            draggable={false}
            className="object-contain"
          />
          <MaskOverlay
            maskAssetId={input.maskAssetId ?? ""}
            color="#22d3ee"
            opacity={input.maskOpacity}
            visible={input.maskVisible && input.maskAssetId !== null}
            label="object-mask"
          />
          <MaskOverlay
            maskAssetId={input.allowedMaskAssetId ?? ""}
            color="#f59e0b"
            opacity={0.22}
            visible={input.allowedVisible && input.allowedMaskAssetId !== null}
            label="allowed-region"
          />
          {marker(input.positivePoint, "bg-emerald-500", "Positive point")}
          {marker(input.negativePoint, "bg-red-500", "Negative point")}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-stone-500">
        Click inside the image to place a point. The canvas is disabled while a selection runs.
      </p>
    </div>
  );
}

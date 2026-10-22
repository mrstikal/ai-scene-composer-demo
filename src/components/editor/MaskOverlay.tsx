"use client";

import type { CSSProperties } from "react";

export function MaskOverlay(input: {
  maskAssetId: string;
  color: string;
  opacity: number;
  visible: boolean;
  label: string;
}) {
  if (!input.visible) return null;

  const url = `url("/api/assets/${input.maskAssetId}")`;
  const style: CSSProperties & { WebkitMaskSourceType?: "luminance" } = {
    backgroundColor: input.color,
    opacity: input.opacity,
    maskImage: url,
    WebkitMaskImage: url,
    maskMode: "luminance",
    WebkitMaskSourceType: "luminance",
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };

  return (
    <div
      aria-hidden="true"
      data-overlay={input.label}
      className="pointer-events-none absolute inset-0"
      style={style}
    />
  );
}

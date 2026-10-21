export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanonicalPoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mapPointerToCanonical(input: {
  rect: DisplayRect;
  clientX: number;
  clientY: number;
  canonicalSize?: number;
}): CanonicalPoint | null {
  const size = input.canonicalSize ?? 1024;
  const { rect, clientX, clientY } = input;

  if (size <= 0 || rect.width <= 0 || rect.height <= 0) return null;

  const scale = Math.min(rect.width / size, rect.height / size);
  const displayedWidth = size * scale;
  const displayedHeight = size * scale;
  const displayedLeft = rect.left + (rect.width - displayedWidth) / 2;
  const displayedTop = rect.top + (rect.height - displayedHeight) / 2;

  if (
    clientX < displayedLeft ||
    clientX >= displayedLeft + displayedWidth ||
    clientY < displayedTop ||
    clientY >= displayedTop + displayedHeight
  ) {
    return null;
  }

  const x = Math.floor(((clientX - displayedLeft) * size) / displayedWidth);
  const y = Math.floor(((clientY - displayedTop) * size) / displayedHeight);

  return {
    x: clamp(x, 0, size - 1),
    y: clamp(y, 0, size - 1),
  };
}

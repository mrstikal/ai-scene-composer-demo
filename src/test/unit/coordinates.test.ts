import { describe, expect, it } from "vitest";

import { mapPointerToCanonical } from "@/lib/images/coordinates";

describe("canonical pointer mapping", () => {
  const square = { left: 0, top: 0, width: 1024, height: 1024 };

  it("maps center and corners", () => {
    expect(mapPointerToCanonical({ rect: square, clientX: 512, clientY: 512 })).toEqual({
      x: 512,
      y: 512,
    });
    expect(mapPointerToCanonical({ rect: square, clientX: 0, clientY: 0 })).toEqual({ x: 0, y: 0 });
    expect(mapPointerToCanonical({ rect: square, clientX: 1023.9, clientY: 1023.9 })).toEqual({
      x: 1023,
      y: 1023,
    });
  });

  it("uses half-open bounds and rejects the exclusive edge and outside clicks", () => {
    expect(mapPointerToCanonical({ rect: square, clientX: 1024, clientY: 512 })).toBeNull();
    expect(mapPointerToCanonical({ rect: square, clientX: 512, clientY: -1 })).toBeNull();
    expect(mapPointerToCanonical({ rect: square, clientX: 512, clientY: 1024 })).toBeNull();
  });

  it("excludes CSS letterboxing", () => {
    const letterboxed = { left: 100, top: 50, width: 1200, height: 800 };
    expect(mapPointerToCanonical({ rect: letterboxed, clientX: 300, clientY: 450 })).toEqual({
      x: 0,
      y: 512,
    });
    expect(mapPointerToCanonical({ rect: letterboxed, clientX: 299, clientY: 450 })).toBeNull();
    expect(mapPointerToCanonical({ rect: letterboxed, clientX: 1099.9, clientY: 450 })).toEqual({
      x: 1023,
      y: 512,
    });
    expect(mapPointerToCanonical({ rect: letterboxed, clientX: 1100, clientY: 450 })).toBeNull();
  });

  it("rejects zero-size elements and supports another canonical size", () => {
    expect(
      mapPointerToCanonical({ rect: { left: 0, top: 0, width: 0, height: 100 }, clientX: 0, clientY: 0 }),
    ).toBeNull();
    expect(
      mapPointerToCanonical({
        rect: { left: 0, top: 0, width: 512, height: 512 },
        clientX: 511,
        clientY: 511,
        canonicalSize: 512,
      }),
    ).toEqual({ x: 511, y: 511 });
  });
});

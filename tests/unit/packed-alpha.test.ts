import { describe, expect, it } from "vitest";

import {
  hasTransparentProbePixel,
  packedOutputPixel,
  packedUv,
} from "../../src/motion/packed-alpha";

describe("packed color + matte alpha math", () => {
  it("maps the output UV halves without swapping color and matte", () => {
    expect(packedUv({ x: 0, y: 0.25 })).toEqual({ colorX: 0, matteX: 0.5, y: 0.25 });
    expect(packedUv({ x: 1, y: 0.75 })).toEqual({ colorX: 0.5, matteX: 1, y: 0.75 });
  });

  it("uses the matte as straight alpha, including a transparent black corner", () => {
    expect(packedOutputPixel([1, 1, 1], 0)).toEqual([1, 1, 1, 0]);
    expect(packedOutputPixel([0.25, 0.5, 0.75], 1)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(packedOutputPixel([0, 0, 0], -1)).toEqual([0, 0, 0, 0]);
  });

  it("accepts a probe only when a known corner is actually transparent", () => {
    const transparentCorner = new Uint8ClampedArray([
      255, 255, 255, 0,
      255, 255, 255, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
    ]);
    const opaqueBlack = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    expect(hasTransparentProbePixel(transparentCorner)).toBe(true);
    expect(hasTransparentProbePixel(opaqueBlack)).toBe(false);
  });
});

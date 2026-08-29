/**
 * PROTOTYPE ONLY — pure checks for the packed color + matte shader.
 *
 * The packed video stores RGB in the left half and a grayscale matte in the
 * right half. These helpers keep the UV split and straight-alpha output
 * deterministic enough to test without a WebGL context.
 */
export type PackedUv = { x: number; y: number };
export type PackedOutputPixel = readonly [number, number, number, number];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function packedUv(uv: PackedUv): { colorX: number; matteX: number; y: number } {
  const x = clamp01(uv.x);
  return { colorX: x * 0.5, matteX: 0.5 + x * 0.5, y: clamp01(uv.y) };
}

export function packedOutputPixel(
  color: readonly [number, number, number],
  matte: number,
): PackedOutputPixel {
  return [clamp01(color[0]), clamp01(color[1]), clamp01(color[2]), clamp01(matte)];
}

/** Return true when any of the four probe corners has a transparent alpha. */
export function hasTransparentProbePixel(rgba: ArrayLike<number>, alphaThreshold = 250): boolean {
  if (rgba.length < 16) return false;
  const threshold = Math.max(0, Math.min(255, alphaThreshold));
  return [3, 7, 11, 15].some((index) => rgba[index] < threshold);
}

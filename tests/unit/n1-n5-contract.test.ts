import { describe, expect, it } from "vitest";

import {
  computeHeroLayout,
  computeMobileHeroCopyTop,
  computeMobileHeroAssetPlacement,
  HERO_LAYOUT_CONTRACT,
  MOBILE_HERO_ASSET_ENVELOPE,
  MOBILE_HERO_CONTRACT,
  mobileHeroConsumesDownwardScroll,
  mobileHeroDownwardScrollDisposition,
} from "../../src/motion/hero-contract";

describe("N1–N5 measurable hero/layout contracts", () => {
  it("N3 places the mobile copy slot 24px below its former 9% anchor", () => {
    const layout = computeHeroLayout({
      width: 390,
      stableHeight: 844,
      visualHeight: 844,
      dpr: 2,
      mode: "mobile",
    });

    expect(layout.copyAnchor.y).toBeCloseTo(844 * 0.09 + 24, 8);
    expect(layout.copyAnchor.y - 844 * 0.09).toBe(24);
    expect(HERO_LAYOUT_CONTRACT.mobileCopyOffsetPx).toBe(24);
  });

  it("N3 caps the mobile copy nudge by the stage on a 320x480 viewport", () => {
    const layout = computeHeroLayout({
      width: 320,
      stableHeight: 480,
      visualHeight: 480,
      dpr: 2,
      mode: "mobile",
    });
    const requestedTop = 480 * HERO_LAYOUT_CONTRACT.mobileCopyTopRatio + 24;
    const formerTop = 480 * HERO_LAYOUT_CONTRACT.mobileCopyTopRatio;

    expect(layout.copyAnchor.y).toBe(computeMobileHeroCopyTop(480));
    expect(layout.copyAnchor.y).toBeLessThan(requestedTop);
    expect(layout.copyAnchor.y).toBeGreaterThan(formerTop);
    expect(layout.copyAnchor.y + HERO_LAYOUT_CONTRACT.mobileCopySafeHeightPx)
      .toBeLessThanOrEqual(layout.stage.top);
  });

  it("N1 consumes downward input until the semantic 14+ transition", () => {
    const handoffFrame = MOBILE_HERO_CONTRACT.experience.fadeIn;
    expect(mobileHeroConsumesDownwardScroll({ phase: "loading", targetFrame: 0 })).toBe(true);
    expect(mobileHeroConsumesDownwardScroll({ phase: "intro", targetFrame: 20 })).toBe(true);
    expect(mobileHeroConsumesDownwardScroll({ phase: "ready", targetFrame: 31 })).toBe(true);
    expect(mobileHeroConsumesDownwardScroll({ phase: "playing", targetFrame: handoffFrame - 0.01 })).toBe(true);
    expect(mobileHeroConsumesDownwardScroll({ phase: "playing", targetFrame: handoffFrame })).toBe(false);
    expect(mobileHeroConsumesDownwardScroll({ phase: "playing", targetFrame: handoffFrame + 1 })).toBe(false);
    expect(mobileHeroConsumesDownwardScroll({ phase: "playing", targetFrame: handoffFrame, reducedMotion: true })).toBe(false);
    expect(mobileHeroConsumesDownwardScroll({ phase: "released", targetFrame: 149 })).toBe(false);
  });

  it("N1 exposes the exact boundary as a next-gesture native handoff", () => {
    const handoffFrame = MOBILE_HERO_CONTRACT.experience.fadeIn;
    expect(mobileHeroDownwardScrollDisposition({ phase: "playing", targetFrame: handoffFrame - 0.01 }))
      .toBe("consume");
    expect(mobileHeroDownwardScrollDisposition({ phase: "playing", targetFrame: handoffFrame }))
      .toBe("native-next-gesture");
  });

  it("N2 names the 40% mobile asset scale and visual-center anchor", () => {
    expect(MOBILE_HERO_CONTRACT.assetScale / 0.55).toBeCloseTo(1.4, 8);
    expect(MOBILE_HERO_CONTRACT.assetScale).toBe(0.77);
    expect(MOBILE_HERO_CONTRACT.assetVisualCenterRatio).toBeCloseTo((166 + 756) / (2 * 900), 8);
  });

  it("N2 keeps the full-frame alpha envelope inside representative mobile canvases", () => {
    for (const canvasWidth of [390, 360]) {
      for (const checkpoint of [
        { name: "early", frame: 31 },
        { name: "mid", frame: 90 },
        { name: "terminal", frame: 149 },
      ]) {
        const placement = computeMobileHeroAssetPlacement({
          canvasWidth,
          canvasHeight: 844 * (0.85 - 0.38),
          naturalWidth: MOBILE_HERO_ASSET_ENVELOPE.naturalWidth,
          naturalHeight: MOBILE_HERO_ASSET_ENVELOPE.naturalHeight,
        });
        const left = placement.x + MOBILE_HERO_ASSET_ENVELOPE.left * placement.scale;
        const right = placement.x + MOBILE_HERO_ASSET_ENVELOPE.right * placement.scale;
        expect(left, `alpha envelope left at ${checkpoint.name}/${canvasWidth}px`).toBeGreaterThanOrEqual(0);
        expect(right, `alpha envelope right at ${checkpoint.name}/${canvasWidth}px`).toBeLessThanOrEqual(canvasWidth);
        expect(placement.y, `source top at ${checkpoint.name}/${canvasWidth}px`).toBeGreaterThanOrEqual(0);
        expect(placement.y + placement.height, `source bottom at ${checkpoint.name}/${canvasWidth}px`)
          .toBeLessThanOrEqual(844 * (0.85 - 0.38));
      }
    }
  });
});

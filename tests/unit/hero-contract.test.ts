import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MOBILE_HERO_CONTRACT,
  computeStableMobileHeroLayout,
  sampleMobileHeroCues,
} from "../../src/motion/hero-contract";
import { isFiniteRect } from "../../src/motion/types";

describe("mobile hero contract", () => {
  it("M1 keeps geometry stable when only the visual viewport height changes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 320, max: 768 }),
        fc.integer({ min: 568, max: 1024 }),
        fc.integer({ min: 420, max: 1100 }),
        fc.integer({ min: 420, max: 1100 }),
        fc.double({ min: 1, max: 4, noNaN: true }),
        (width, stableHeight, firstVisualHeight, secondVisualHeight, dpr) => {
          const first = computeStableMobileHeroLayout({
            width,
            stableHeight,
            visualHeight: firstVisualHeight,
            dpr,
          });
          const second = computeStableMobileHeroLayout({
            width,
            stableHeight,
            visualHeight: secondVisualHeight,
            dpr,
          });
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("M1 keeps the stage finite, below copy, and anchored to the hero boundary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 320, max: 768 }),
        fc.integer({ min: 568, max: 1024 }),
        fc.double({ min: 1, max: 4, noNaN: true }),
        (width, stableHeight, dpr) => {
          const layout = computeStableMobileHeroLayout({
            width,
            stableHeight,
            visualHeight: stableHeight,
            dpr,
          });
          expect(isFiniteRect(layout.stage)).toBe(true);
          expect(layout.stage.top).toBeGreaterThan(layout.copyAnchor.y);
          expect(layout.stage.bottom).toBeCloseTo(layout.boundaryY, 8);
          expect(layout.firstScreen.bottom).toBe(stableHeight);
          expect(layout.backingStore.effectiveDpr).toBeLessThanOrEqual(2);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("M2 gives the role and experience cues separate steady states", () => {
    expect(sampleMobileHeroCues(31)).toEqual({ roleOpacity: 1, experienceOpacity: 0 });
    expect(sampleMobileHeroCues(90)).toEqual({ roleOpacity: 0, experienceOpacity: 1 });
  });

  it("M2 limits overlap to the declared replacement interval", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 149, noNaN: true }), (frame) => {
        const cues = sampleMobileHeroCues(frame);
        if (cues.roleOpacity > 0 && cues.experienceOpacity > 0) {
          expect(frame).toBeGreaterThanOrEqual(MOBILE_HERO_CONTRACT.experience.fadeIn);
          expect(frame).toBeLessThanOrEqual(MOBILE_HERO_CONTRACT.role.end);
        }
      }),
      { numRuns: 500 },
    );
  });
});


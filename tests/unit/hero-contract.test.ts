import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  HERO_CONTRACT,
  MOBILE_HERO_CONTRACT,
  computeHeroLayout,
  computeStableMobileHeroLayout,
  smoothHeroFrame,
  sampleHeroCTA,
  sampleHeroTimeline,
  sampleMobileHeroCues,
  sampleMobileHeroPresentation,
  transitionHeroPhase,
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

  it("M2 never renders both replacement groups at once", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 149, noNaN: true }), (frame) => {
        const cues = sampleMobileHeroCues(frame);
        expect(cues.roleOpacity > 0 && cues.experienceOpacity > 0).toBe(false);
      }),
      { numRuns: 500 },
    );
    expect(sampleMobileHeroCues(MOBILE_HERO_CONTRACT.role.end)).toEqual({
      roleOpacity: 0,
      experienceOpacity: 0,
    });
  });

  it("keeps the canonical mobile stage between 38% and the 85% boundary", () => {
    const layout = computeStableMobileHeroLayout({
      width: 390,
      visualHeight: 700,
      stableHeight: 844,
      dpr: 3,
    });
    expect(layout.stage.top).toBeCloseTo(844 * 0.38, 8);
    expect(layout.stage.bottom).toBeCloseTo(844 * 0.85, 8);
    expect(layout.boundaryY).toBeCloseTo(844 * MOBILE_HERO_CONTRACT.boundaryRatio, 8);
    expect(layout.backingStore.effectiveDpr).toBe(2);
  });

  it("uses the same layout source for desktop stage, copy, CTA, hint, About, and DPR", () => {
    const layout = computeHeroLayout({
      width: 1440,
      visualHeight: 900,
      stableHeight: 900,
      dpr: 3,
      mode: "desktop",
    });

    expect(layout).toMatchObject({
      mode: "desktop",
      firstScreen: { width: 1440, height: 900, bottom: 900 },
      stage: { top: 0, bottom: 765, width: 1440, height: 765 },
      canvas: { top: 0, bottom: 765, width: 1440, height: 765 },
      boundary: { top: 765, bottom: 765, width: 1440 },
      boundaryY: 765,
      ctaAnchor: { x: 720, y: 765 },
      hintAnchor: { x: 720, y: 827 },
      aboutOverlap: 135,
      backingStore: { width: 2880, height: 1530, effectiveDpr: 2 },
    });
    expect(layout.copyAnchors.role).toEqual({ x: 86.39999999999999, y: 342 });
    expect(layout.copyAnchors.experience).toEqual({ x: 1353.6, y: 342 });
  });

  it.each([
    { phase: "loading" as const, elapsedMs: 0, frame: HERO_CONTRACT.startFrame, progress: 0 },
    { phase: "intro" as const, elapsedMs: 0, frame: HERO_CONTRACT.startFrame, progress: 0 },
    { phase: "intro" as const, elapsedMs: HERO_CONTRACT.introDurationMs, frame: HERO_CONTRACT.introEndFrame, progress: 1 },
    { phase: "ready" as const, elapsedMs: 0, frame: HERO_CONTRACT.introEndFrame, progress: 0 },
    { phase: "playing" as const, elapsedMs: 0, frame: HERO_CONTRACT.introEndFrame, progress: 0 },
    { phase: "playing" as const, elapsedMs: HERO_CONTRACT.playbackDurationMs, frame: HERO_CONTRACT.endFrame, progress: 1 },
    { phase: "complete" as const, elapsedMs: 0, frame: HERO_CONTRACT.endFrame, progress: 1 },
    { phase: "released" as const, elapsedMs: 0, frame: HERO_CONTRACT.endFrame, progress: 1 },
  ])("samples the elapsed-time hero timeline at %#", (table) => {
    expect(sampleHeroTimeline(table.phase, table.elapsedMs)).toEqual({
      targetFrame: table.frame,
      progress: table.progress,
    });
  });

  it("gives refresh-rate-independent samples at matching wall-clock time", () => {
    const elapsedMs = 1_750;
    const samples = [30, 60, 120].map(() => sampleHeroTimeline("playing", elapsedMs));
    expect(samples[1]).toEqual(samples[0]);
    expect(samples[2]).toEqual(samples[0]);
  });

  it("uses elapsed-delta exponential smoothing with equivalent cadence", () => {
    expect(smoothHeroFrame(0, 100, 1000 / 60)).toBeCloseTo(7, 12);

    const settle = (frameMs: number): number => {
      let display = 0;
      for (let tick = 0; tick < Math.round(1000 / frameMs); tick += 1) {
        display = smoothHeroFrame(display, 100, frameMs);
      }
      return display;
    };
    expect(settle(1000 / 30)).toBeCloseTo(settle(1000 / 60), 10);
    expect(settle(1000 / 120)).toBeCloseTo(settle(1000 / 60), 10);
  });

  it.each([
    { phase: "loading" as const, targetFrame: 0, available: false },
    { phase: "intro" as const, targetFrame: 31, available: false },
    { phase: "ready" as const, targetFrame: 31, available: false },
    { phase: "playing" as const, targetFrame: 127.99, available: false },
    { phase: "playing" as const, targetFrame: 128, available: true },
    { phase: "complete" as const, targetFrame: 149, available: true },
    { phase: "exit-hold" as const, targetFrame: 149, available: true },
    { phase: "released" as const, targetFrame: 149, available: true },
    { phase: "reduced" as const, targetFrame: 149, available: true },
  ])("computes named CTA availability at %#", (table) => {
    const cta = sampleHeroCTA({ phase: table.phase, targetFrame: table.targetFrame });
    expect(cta.available).toBe(table.available);
    expect(cta.state).toBe(table.available ? "available" : "unavailable");
    expect(cta.opacity).toBe(table.available ? 1 : 0);
    expect(cta.pointerEvents).toBe(table.available ? "all" : "none");
  });

  it("latches CTA availability across a later frame regression and enables it immediately for reduced motion", () => {
    expect(
      sampleHeroCTA({ phase: "playing", targetFrame: 90, latched: true }),
    ).toMatchObject({ state: "available", available: true });
    expect(
      sampleHeroCTA({ phase: "playing", targetFrame: 0, reducedMotion: true }),
    ).toMatchObject({ state: "available", pointerEvents: "all" });
  });

  it("exposes sequential mobile cues and the CTA as one presentation contract", () => {
    expect(sampleMobileHeroPresentation({ phase: "ready", targetFrame: 31 })).toMatchObject({
      roleOpacity: 1,
      experienceOpacity: 0,
      cue: "role",
      cta: { state: "unavailable", pointerEvents: "none" },
    });
    expect(sampleMobileHeroPresentation({ phase: "playing", targetFrame: 90 })).toMatchObject({
      roleOpacity: 0,
      experienceOpacity: 1,
      cue: "experience",
    });
    expect(sampleMobileHeroPresentation({ phase: "playing", targetFrame: 128 })).toMatchObject({
      cue: "cta",
      cta: { state: "available", opacity: 1, pointerEvents: "all" },
    });
    expect(sampleMobileHeroPresentation({ phase: "reduced", targetFrame: 0 })).toMatchObject({
      roleOpacity: 1,
      experienceOpacity: 1,
      cue: "cta",
      cta: { state: "available" },
    });
  });

  it.each(["complete", "exit-hold"] as const)(
    "keeps the terminal experience copy visible after the hero finishes (%s)",
    (phase) => {
      expect(
        sampleMobileHeroPresentation({
          phase,
          targetFrame: HERO_CONTRACT.endFrame,
          playbackCompleted: true,
        }),
      ).toMatchObject({ roleOpacity: 0, experienceOpacity: 1 });
    },
  );

  it("keeps the terminal copy through released only after observed playback completion", () => {
    expect(
      sampleMobileHeroPresentation({
        phase: "released",
        targetFrame: HERO_CONTRACT.endFrame,
        playbackCompleted: true,
      }),
    ).toMatchObject({ roleOpacity: 0, experienceOpacity: 1 });
    expect(
      sampleMobileHeroPresentation({
        phase: "released",
        targetFrame: HERO_CONTRACT.endFrame,
        playbackCompleted: false,
      }),
    ).toMatchObject({ roleOpacity: 0, experienceOpacity: 0 });
  });

  it.each([
    ["loading", "assets-ready", "intro"],
    ["intro", "intro-complete", "ready"],
    ["ready", "advance", "playing"],
    ["playing", "playback-complete", "complete"],
    ["complete", "request-exit", "exit-hold"],
    ["exit-hold", "exit-delay-complete", "released"],
    ["exit-hold", "cancel-exit", "complete"],
  ] as const)("transitions the pure hero phase %#", (phase, event, next) => {
    expect(transitionHeroPhase(phase, event)).toBe(next);
  });

  it("makes repeated and invalid input idempotent while reduced motion dominates", () => {
    expect(transitionHeroPhase("ready", "advance")).toBe("playing");
    expect(transitionHeroPhase("ready", "advance")).toBe("playing");
    expect(transitionHeroPhase("ready", "playback-complete")).toBe("ready");
    expect(transitionHeroPhase("playing", "reduced-motion")).toBe("reduced");
    expect(transitionHeroPhase("reduced", "release")).toBe("reduced");
  });
});

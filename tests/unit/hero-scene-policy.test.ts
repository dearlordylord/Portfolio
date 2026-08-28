import { describe, expect, it } from "vitest";

import {
  HERO_C_FRAME_CACHE_CAPACITY,
  HERO_C_INTRO_LOAD_CONCURRENCY,
  HERO_C_LOAD_CONCURRENCY,
  HERO_C_MAX_DECODED_RESOURCES,
  HERO_C_PREFETCH_RADIUS,
  HERO_NATIVE_FALLBACK_FRAME_TOLERANCE,
  mobileHeroInputDisposition,
  shouldCommitNativeFallbackHandoff,
} from "../../src/browser/hero-scene";

describe("production hero scene fallback policy", () => {
  it("keeps C decode residency and request concurrency bounded", () => {
    expect(HERO_C_FRAME_CACHE_CAPACITY).toBe(32);
    expect(HERO_C_PREFETCH_RADIUS).toBe(3);
    expect(HERO_C_LOAD_CONCURRENCY).toBe(4);
    expect(HERO_C_INTRO_LOAD_CONCURRENCY).toBe(8);
    // The resident cache is the only unbounded-sequence resource owner. A
    // target request may add at most the fixed in-flight decode allowance.
    expect(HERO_C_MAX_DECODED_RESOURCES).toBe(40);
  });

  it("keeps mobile downward input consumed during native preparation", () => {
    expect(mobileHeroInputDisposition({
      mobile: true,
      phase: "loading",
      targetFrame: 0,
      nativePreparationPending: true,
      readinessWatchdogPending: false,
      hasRenderableFrame: false,
    })).toBe("consume");
  });

  it("fails open after the native and C readiness windows are no longer pending", () => {
    expect(mobileHeroInputDisposition({
      mobile: true,
      phase: "loading",
      targetFrame: 0,
      nativePreparationPending: false,
      readinessWatchdogPending: false,
      hasRenderableFrame: false,
    })).toBe("native-next-gesture");
    expect(mobileHeroInputDisposition({
      mobile: true,
      phase: "playing",
      targetFrame: 90,
      nativePreparationPending: false,
      readinessWatchdogPending: false,
      hasRenderableFrame: true,
    })).toBe("native-next-gesture");
  });

  it("retains the normal semantic mobile lock while C is waiting for intro", () => {
    expect(mobileHeroInputDisposition({
      mobile: true,
      phase: "loading",
      targetFrame: 0,
      nativePreparationPending: false,
      readinessWatchdogPending: true,
      hasRenderableFrame: false,
    })).toBe("consume");
    expect(mobileHeroInputDisposition({
      mobile: false,
      phase: "loading",
      targetFrame: 0,
      nativePreparationPending: true,
    })).toBe("native-next-gesture");
  });

  it("commits only a decoded C frame within the explicit handoff tolerance", () => {
    const targetFrame = 90;
    expect(HERO_NATIVE_FALLBACK_FRAME_TOLERANCE).toBe(3);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame, decoded: true })).toBe(true);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame - 3, decoded: true })).toBe(true);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame + 3, decoded: true })).toBe(true);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame - 4, decoded: true })).toBe(false);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame + 4, decoded: true })).toBe(false);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: targetFrame, decoded: false })).toBe(false);
    expect(shouldCommitNativeFallbackHandoff({ targetFrame, renderedFrame: null, decoded: true })).toBe(false);
  });
});

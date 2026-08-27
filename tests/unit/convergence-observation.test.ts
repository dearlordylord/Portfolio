import { describe, expect, it } from "vitest";
import {
  characterizeTemporalTrace,
  heightRatio,
  horizontalGap,
  verticalOffset,
  type ObservedRect,
  type TemporalTrace,
} from "../../src/motion/convergence-observation";

const rect = (left: number, top: number, width: number, height: number): ObservedRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("convergence observations", () => {
  it("measures independent rendered relationships", () => {
    expect(heightRatio(rect(0, 20, 100, 70), rect(0, 0, 100, 100))).toBe(0.7);
    expect(verticalOffset(rect(0, 32, 10, 10), rect(0, 10, 10, 10))).toBe(22);
    expect(horizontalGap(rect(0, 0, 20, 10), rect(36, 0, 10, 10))).toBe(16);
    expect(horizontalGap(null, rect(0, 0, 1, 1))).toBeNull();
  });

  it("finds the input, progress, and native-scroll boundaries without declaring a target", () => {
    const sample = (step: number, progress: number, scrollY: number, trusted = step > 0) => ({
      step,
      elapsedMs: step * 16,
      input: step === 0 ? null : { kind: "wheel" as const, trusted, deltaY: 120, defaultPrevented: false },
      hero: { phase: progress ? "playing" : "ready", playbackCompleted: false, targetFrame: progress * 149, displayFrame: progress * 149, renderedFrame: Math.round(progress * 149), progress },
      document: { scrollX: 0, scrollY, programmaticScrollCalls: 0 },
      visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
    });
    const trace: TemporalTrace = {
      clock: "playwright-paused",
      samples: [sample(0, 0, 0), sample(1, 0.25, 0), sample(2, 0.4, 80)],
    };
    expect(characterizeTemporalTrace(trace)).toEqual({
      valid: true,
      firstProgressStep: 1,
      firstDocumentScrollStep: 2,
      firstInputDrivenScrollStep: 2,
      firstProgrammaticScrollStep: null,
      firstTrustedInputStep: 1,
      scrollBeforeHalfProgress: true,
    });
  });

  it("rejects unordered or non-finite traces", () => {
    const trace = {
      clock: "playwright-paused" as const,
      samples: [
        { step: 1, elapsedMs: 16, input: null, hero: { phase: "ready", playbackCompleted: false, targetFrame: 0, displayFrame: 0, renderedFrame: 0, progress: Number.NaN }, document: { scrollX: 0, scrollY: 0, programmaticScrollCalls: 0 }, visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 } },
        { step: 0, elapsedMs: 0, input: null, hero: { phase: "ready", playbackCompleted: false, targetFrame: 0, displayFrame: 0, renderedFrame: 0, progress: 0 }, document: { scrollX: 0, scrollY: 0, programmaticScrollCalls: 0 }, visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 } },
      ],
    };
    expect(characterizeTemporalTrace(trace).valid).toBe(false);
  });

  it("does not attribute later smooth-scroll displacement to a fresh input", () => {
    const base = {
      hero: { phase: "complete", playbackCompleted: true, targetFrame: 149, displayFrame: 149, renderedFrame: 149, progress: 1 },
      visualViewport: { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 },
    };
    const trace: TemporalTrace = {
      clock: "playwright-paused",
      samples: [
        { ...base, step: 0, elapsedMs: 0, input: null, document: { scrollX: 0, scrollY: 0, programmaticScrollCalls: 0 } },
        { ...base, step: 1, elapsedMs: 16, input: { kind: "wheel", trusted: true, deltaY: 120, defaultPrevented: true }, document: { scrollX: 0, scrollY: 20, programmaticScrollCalls: 1 } },
        { ...base, step: 2, elapsedMs: 32, input: { kind: "wheel", trusted: true, deltaY: 120, defaultPrevented: false }, document: { scrollX: 0, scrollY: 80, programmaticScrollCalls: 1 } },
      ],
    };
    expect(characterizeTemporalTrace(trace)).toMatchObject({
      firstProgrammaticScrollStep: 1,
      firstInputDrivenScrollStep: null,
    });
  });
});

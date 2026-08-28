import { describe, expect, it } from "vitest";

import {
  sampleNativeTimeline,
  shouldProjectNativeTimeline,
} from "../../src/motion/native-timeline";

describe("native presented-media timeline", () => {
  it("derives the application timeline exclusively from presented media time", () => {
    expect(sampleNativeTimeline(20 / 15)).toMatchObject({
      frame: 20,
      phase: "intro",
      phaseElapsedMs: expect.closeTo(20 / 31 * 1_400, 8),
      playbackCompleted: false,
    });
    expect(sampleNativeTimeline(31 / 15)).toMatchObject({
      frame: 31,
      phase: "playing",
      phaseElapsedMs: 0,
      playbackCompleted: false,
    });
    expect(sampleNativeTimeline(149 / 15)).toMatchObject({
      frame: 149,
      phase: "complete",
      phaseElapsedMs: 3_500,
      playbackCompleted: true,
    });
  });

  it("does not let media timeupdate-like samples invent presented progress", () => {
    const first = sampleNativeTimeline(31 / 15);
    const later = sampleNativeTimeline(31 / 15);
    expect(later).toEqual(first);
  });

  it("crosses both semantic boundaries in order on presented frames alone", () => {
    const samples = [0, 15, 30, 31, 32, 90, 149].map((frame) =>
      sampleNativeTimeline(frame / 15),
    );

    expect(samples.map((sample) => sample.frame)).toEqual([0, 15, 30, 31, 32, 90, 149]);
    expect(samples.map((sample) => sample.phase)).toEqual([
      "intro",
      "intro",
      "intro",
      "playing",
      "playing",
      "playing",
      "complete",
    ]);
    expect(samples.at(-1)).toMatchObject({ playbackCompleted: true, phaseElapsedMs: 3_500 });
  });

  it.each([
    ["document hidden", { documentVisible: false, heroVisible: true }],
    ["hero offscreen", { documentVisible: true, heroVisible: false }],
  ])("does not project a callback while %s", (_label, visibility) => {
    expect(shouldProjectNativeTimeline({
      nativeActive: true,
      nativeVisible: true,
      nativeStopped: false,
      phase: "playing",
      ...visibility,
    })).toBe(false);
  });

  it("projects only an active visible native timed phase", () => {
    expect(shouldProjectNativeTimeline({
      nativeActive: true,
      nativeVisible: true,
      nativeStopped: false,
      documentVisible: true,
      heroVisible: true,
      phase: "playing",
    })).toBe(true);
    expect(shouldProjectNativeTimeline({
      nativeActive: true,
      nativeVisible: true,
      nativeStopped: false,
      documentVisible: true,
      heroVisible: true,
      phase: "complete",
    })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  decideNativePlaybackSync,
  type NativePlaybackSyncInput,
} from "../../src/motion/native-playback-sync";

function input(overrides: Partial<NativePlaybackSyncInput> = {}): NativePlaybackSyncInput {
  return {
    phase: "intro",
    currentTimeSeconds: 0,
    targetTimeSeconds: 0,
    desiredPlaybackRate: 1.4,
    currentPlaybackRate: null,
    phaseChanged: true,
    initialPositioned: true,
    paused: false,
    recoverySuppressed: false,
    ...overrides,
  };
}

describe("native playback clock policy", () => {
  it("does not seek during healthy intro or playing frames", () => {
    const healthyIntro = decideNativePlaybackSync(input({
      currentTimeSeconds: 0.9,
      targetTimeSeconds: 0.6,
      currentPlaybackRate: 1.4,
      phaseChanged: false,
    }));
    const healthyMain = decideNativePlaybackSync(input({
      phase: "playing",
      currentTimeSeconds: 4.8,
      targetTimeSeconds: 4.1,
      desiredPlaybackRate: 2.25,
      currentPlaybackRate: 2.25,
      phaseChanged: false,
    }));

    expect(healthyIntro.seekToSeconds).toBeNull();
    expect(healthyMain.seekToSeconds).toBeNull();
    expect(healthyIntro.reason).toBe("healthy-clock");
    expect(healthyMain.reason).toBe("healthy-clock");
  });

  it("changes rate at the intro boundary without a redundant seek", () => {
    const decision = decideNativePlaybackSync(input({
      phase: "playing",
      currentTimeSeconds: 31 / 15,
      targetTimeSeconds: 31 / 15,
      desiredPlaybackRate: 118 / 15 / 3.5,
      currentPlaybackRate: 31 / 15 / 1.4,
      phaseChanged: true,
    }));

    expect(decision.seekToSeconds).toBeNull();
    expect(decision.setPlaybackRate).toBeCloseTo(118 / 15 / 3.5, 12);
    expect(decision.play).toBe(false);
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("phase-rate-change");
  });

  it("allows one initial position but never treats an equivalent first frame as a seek", () => {
    const equivalent = decideNativePlaybackSync(input({
      currentTimeSeconds: 0.001,
      targetTimeSeconds: 0,
      initialPositioned: false,
    }));
    const required = decideNativePlaybackSync(input({
      currentTimeSeconds: 0.4,
      targetTimeSeconds: 0,
      initialPositioned: false,
    }));

    expect(equivalent.seekToSeconds).toBeNull();
    expect(required.seekToSeconds).toBe(0);
    expect(required.reason).toBe("initial-position");
  });

  it("only seeks a settled native surface to its terminal or intentional target", () => {
    const decision = decideNativePlaybackSync(input({
      phase: "complete",
      currentTimeSeconds: 9.6,
      targetTimeSeconds: 149 / 15,
      phaseChanged: true,
      paused: false,
    }));

    expect(decision.pause).toBe(true);
    expect(decision.seekToSeconds).toBe(149 / 15);
    expect(decision.reason).toBe("settled-position");
  });

  it("does not issue a play request while the native underflow guard is active", () => {
    const decision = decideNativePlaybackSync(input({
      paused: true,
      recoverySuppressed: true,
    }));

    expect(decision.play).toBe(false);
    expect(decision.seekToSeconds).toBeNull();
  });
});

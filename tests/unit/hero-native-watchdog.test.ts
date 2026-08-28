import { describe, expect, it } from "vitest";

import {
  advanceNativeWatchdog,
  HERO_NATIVE_H_UNDERFLOW_GRACE_MS,
  advanceNativeHWatchdog,
  initialNativeHWatchdogState,
  initialNativeWatchdogState,
} from "../../src/motion/hero-native-watchdog";

function observation(overrides: Partial<Parameters<typeof advanceNativeHWatchdog>[1]> = {}) {
  return {
    atMs: 0,
    active: true,
    motionExpected: true,
    atTarget: false,
    presentedFrame: 31,
    ...overrides,
  };
}

describe("native presented-frame progress watchdog", () => {
  it("uses the same presented-frame contract for A as for H", () => {
    let state = initialNativeWatchdogState();
    state = advanceNativeWatchdog(state, observation({ atMs: 0, presentedFrame: 0 })).state;
    const stalled = advanceNativeWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS,
      presentedFrame: 0,
      waiting: true,
      stalled: true,
    }));

    expect(stalled.action).toBe("fallback");
    expect(stalled.reason).toBe("underflow-grace-exceeded");
    // The neutral aliases and the historical H names are the same reducer,
    // so A and H cannot silently acquire different stall semantics.
    expect(stalled.state.status).toBe("tripped");
  });

  it("trips only after bounded silence in actual presented frames", () => {
    let state = initialNativeHWatchdogState();
    let result = advanceNativeHWatchdog(state, observation({ atMs: 0 }));
    state = result.state;
    expect(result.action).toBe("none");

    result = advanceNativeHWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS - 1,
      waiting: true,
      stalled: true,
    }));
    state = result.state;
    expect(result.action).toBe("none");
    expect(state.status).toBe("monitoring");
    expect(state.waiting).toBe(true);
    expect(state.stalled).toBe(true);

    result = advanceNativeHWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS,
      waiting: true,
      stalled: true,
    }));
    expect(result.action).toBe("fallback");
    expect(result.reason).toBe("underflow-grace-exceeded");
  });

  it("resets the grace window on forward presented progress", () => {
    let state = initialNativeHWatchdogState();
    state = advanceNativeHWatchdog(state, observation({ atMs: 0 })).state;
    state = advanceNativeHWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS - 1,
      presentedFrame: 32,
      waiting: true,
      stalled: true,
    })).state;
    const recovered = advanceNativeHWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS + 1,
      presentedFrame: 33,
      waiting: false,
      stalled: false,
    }));

    expect(recovered.action).toBe("none");
    expect(recovered.reason).toBe("presented-progress");
    expect(recovered.state.lastPresentedFrame).toBe(33);
    expect(recovered.state.noProgressSinceMs).toBeNull();
    expect(recovered.state.waiting).toBe(false);
    expect(recovered.state.stalled).toBe(false);
  });

  it("does not fall back while motion is intentionally still or already at target", () => {
    let state = initialNativeHWatchdogState();
    const settled = advanceNativeHWatchdog(state, observation({
      atMs: 10_000,
      motionExpected: false,
      atTarget: true,
      waiting: true,
      stalled: true,
    }));
    expect(settled.action).toBe("none");
    expect(settled.state.status).toBe("inactive");

    state = settled.state;
    const atTarget = advanceNativeHWatchdog(state, observation({
      atMs: 20_000,
      atTarget: true,
      waiting: true,
      stalled: true,
    }));
    expect(atTarget.action).toBe("none");
    expect(atTarget.state.status).toBe("inactive");
  });

  it("resets on media recovery and cleanup", () => {
    let state = initialNativeHWatchdogState();
    state = advanceNativeHWatchdog(state, observation({ atMs: 0 })).state;
    state = advanceNativeHWatchdog(state, observation({
      atMs: 400,
      waiting: true,
      stalled: true,
    })).state;
    const recovery = advanceNativeHWatchdog(state, observation({
      atMs: 401,
      recovery: true,
      waiting: false,
      stalled: false,
    }));
    expect(recovery.action).toBe("none");
    expect(recovery.reason).toBe("media-recovery");
    expect(recovery.state.lastProgressAtMs).toBe(0);
    expect(recovery.state.noProgressSinceMs).toBe(0);
    expect(recovery.state.waiting).toBe(false);
    expect(recovery.state.stalled).toBe(false);

    const cleaned = advanceNativeHWatchdog(recovery.state, observation({
      atMs: 402,
      active: false,
      motionExpected: false,
      atTarget: true,
    }));
    expect(cleaned.action).toBe("none");
    expect(cleaned.state.status).toBe("inactive");
    expect(cleaned.state.lastProgressAtMs).toBeNull();
  });

  it("does not let repeated recovery signals hide a same-frame presentation freeze", () => {
    let state = initialNativeHWatchdogState();
    state = advanceNativeHWatchdog(state, observation({ atMs: 0 })).state;
    state = advanceNativeHWatchdog(state, observation({
      atMs: 400,
      waiting: true,
      stalled: true,
    })).state;

    for (const atMs of [401, 550, HERO_NATIVE_H_UNDERFLOW_GRACE_MS - 1]) {
      const recovery = advanceNativeHWatchdog(state, observation({
        atMs,
        recovery: true,
        waiting: false,
        stalled: false,
      }));
      expect(recovery.action).toBe("none");
      expect(recovery.state.lastPresentedFrame).toBe(31);
      expect(recovery.state.lastProgressAtMs).toBe(0);
      expect(recovery.state.noProgressSinceMs).toBe(0);
      expect(recovery.state.waiting).toBe(false);
      expect(recovery.state.stalled).toBe(false);
      state = recovery.state;
    }

    const tripped = advanceNativeHWatchdog(state, observation({
      atMs: HERO_NATIVE_H_UNDERFLOW_GRACE_MS,
      recovery: true,
      waiting: false,
      stalled: false,
    }));
    expect(tripped.action).toBe("fallback");
    expect(tripped.reason).toBe("underflow-grace-exceeded");
  });
});

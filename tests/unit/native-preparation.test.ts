import { describe, expect, it } from "vitest";

import {
  initialNativePreparationState,
  reduceNativePreparation,
} from "../../src/motion/hero-native-preparation";

describe("native first-presentation preparation gate", () => {
  it("keeps the poster gate closed after loadeddata and canplay alone", () => {
    let state = initialNativePreparationState("h");
    state = reduceNativePreparation(state, { type: "loaded-data" });
    state = reduceNativePreparation(state, { type: "can-play" });

    expect(state.status).toBe("hidden");
    expect(state.presentationProof).toBe(false);
  });

  it("commits visibility only after an actual presented-frame proof", () => {
    let state = initialNativePreparationState("h");
    state = reduceNativePreparation(state, { type: "loaded-data" });
    state = reduceNativePreparation(state, { type: "can-play" });
    state = reduceNativePreparation(state, { type: "presented-frame", frame: 0 });

    expect(state.status).toBe("ready");
    expect(state.presentationProof).toBe(true);
  });

  it("keeps a later first callback covered and requires a post-reset frame zero", () => {
    let state = initialNativePreparationState("h");
    state = reduceNativePreparation(state, { type: "loaded-data" });
    state = reduceNativePreparation(state, { type: "can-play" });
    state = reduceNativePreparation(state, { type: "presented-frame", frame: 31 });
    expect(state.status).toBe("hidden");
    expect(state.presentationProof).toBe(false);

    state = reduceNativePreparation(state, { type: "presented-frame", frame: 0 });
    expect(state.status).toBe("ready");
    expect(state.presentationProof).toBe(true);
  });

  it("invalidates an earlier frame-zero proof across a new presentation generation", () => {
    let state = initialNativePreparationState("h");
    state = reduceNativePreparation(state, { type: "loaded-data" });
    state = reduceNativePreparation(state, { type: "can-play" });
    state = reduceNativePreparation(state, { type: "presented-frame", frame: 0 });
    expect(state.status).toBe("ready");
    const generation = state.presentationGeneration;

    state = reduceNativePreparation(state, { type: "reset-presentation" });
    expect(state.status).toBe("hidden");
    expect(state.presentationProof).toBe(false);
    expect(state.firstPresentedFrame).toBeNull();
    expect(state.presentationGeneration).toBe(generation + 1);

    state = reduceNativePreparation(state, { type: "presented-frame", frame: 31 });
    state = reduceNativePreparation(state, { type: "can-play" });
    expect(state.status).toBe("hidden");
    expect(state.presentationProof).toBe(false);

    state = reduceNativePreparation(state, { type: "presented-frame", frame: 0 });
    expect(state.status).toBe("ready");
    expect(state.presentationProof).toBe(true);
  });

  it("requires both alpha and presentation proof for VP9 and fails closed on timeout", () => {
    let state = initialNativePreparationState("a");
    state = reduceNativePreparation(state, { type: "loaded-data" });
    state = reduceNativePreparation(state, { type: "can-play" });
    state = reduceNativePreparation(state, { type: "presented-frame", frame: 0 });
    expect(state.status).toBe("hidden");

    state = reduceNativePreparation(state, { type: "alpha-proof" });
    expect(state.status).toBe("ready");

    const timedOut = reduceNativePreparation(initialNativePreparationState("h"), { type: "timeout" });
    expect(timedOut.status).toBe("failed");
    expect(timedOut.reason).toBe("preparation-timeout");
  });
});

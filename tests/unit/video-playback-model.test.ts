import { describe, expect, it } from "vitest";

import {
  createVideoPlaybackModel,
  playbackHandoffFrame,
  shouldAutoplayHandoff,
  type PlaybackRenderer,
} from "../../src/motion/video-playback-model";

function ready(renderer: PlaybackRenderer = "a") {
  const model = createVideoPlaybackModel({ renderer, frameCount: 150, frameRate: 15, resumeDeadlineMs: 500 });
  model.dispatch({ type: "media-ready", atMs: 0, durationSeconds: 10, currentTimeSeconds: 0 });
  return model;
}

describe("video playback state model", () => {
  it("autoplays every renderer from media-ready at t0", () => {
    for (const renderer of ["a", "b", "c"] as const) {
      const state = ready(renderer).snapshot(1);
      expect(state).toMatchObject({
        renderer,
        intendedFrame: 0,
        mediaCurrentTimeSeconds: 0,
        mediaFrame: 0,
        confirmedPresentedFrame: null,
        targetConfirmedFrame: null,
        postSeekProgressFrame: null,
        targetConfirmationTimedOut: false,
        expectedMotion: true,
        actualPlayback: "playing",
        reason: "autoplay-t0",
      });
    }
  });

  it("requests resume on release before presentation and observes confirmation separately", () => {
    const model = ready();

    model.dispatch({ type: "scrub-input", atMs: 100, frame: 42 });
    expect(model.snapshot(100)).toMatchObject({
      intendedFrame: 42,
      scrubHeldFrame: 42,
      seekTargetFrame: 42,
      targetConfirmedFrame: null,
      postSeekProgressFrame: null,
      seeking: true,
      expectedMotion: true,
      actualPlayback: "paused",
      reason: "seeking",
      resumeRequested: false,
    });

    // Pointerup/change is the play request. A presented-frame callback must
    // not be required before the adapter can call play().
    model.dispatch({ type: "scrub-pointerup", atMs: 110, frame: 0 });
    expect(model.snapshot(110)).toMatchObject({
      intendedFrame: 42,
      seekTargetFrame: 42,
      targetConfirmedFrame: null,
      postSeekProgressFrame: null,
      seeking: true,
      expectedMotion: true,
      actualPlayback: "paused",
      reason: "resume-requested",
      resumeRequested: true,
    });

    // A successful play event is enough to resume; confirmation remains an
    // observational fact about the rendered target.
    model.dispatch({ type: "media-playing", atMs: 120 });
    expect(model.snapshot(120)).toMatchObject({
      actualPlayback: "playing",
      expectedMotion: true,
      resumeRequested: false,
      seeking: true,
    });

    model.dispatch({ type: "media-presented", atMs: 140, frame: 42, currentTimeSeconds: 2.8, source: "rvfc" });
    expect(model.snapshot(140)).toMatchObject({
      intendedFrame: 42,
      mediaCurrentTimeSeconds: 2.8,
      mediaFrame: 42,
      confirmedPresentedFrame: 42,
      confirmationSource: "rvfc",
      targetConfirmedFrame: 42,
      postSeekProgressFrame: null,
      deltaFrames: 0,
      scrubHeldFrame: null,
      seeking: false,
      expectedMotion: true,
      actualPlayback: "playing",
    });

    model.dispatch({ type: "media-presented", atMs: 173, frame: 43, currentTimeSeconds: 43 / 15 });
    expect(model.snapshot(173)).toMatchObject({
      confirmedPresentedFrame: 43,
      deltaFrames: 0,
      targetConfirmedFrame: 42,
      postSeekProgressFrame: 43,
      expectedMotion: true,
      actualPlayback: "playing",
    });
    expect(model.snapshot(173).eventTape.map((entry) => entry.event)).toEqual([
      "media-ready",
      "scrub-input",
      "scrub-pointerup",
      "media-playing",
      "media-presented",
      "media-presented",
    ]);

    // A stale lifecycle value cannot overwrite the captured target or its
    // observational confirmation.
    model.dispatch({ type: "scrub-change", atMs: 181, frame: 0 });
    expect(model.snapshot(181)).toMatchObject({
      intendedFrame: 42,
      seekTargetFrame: 42,
      targetConfirmedFrame: 42,
      scrubHeldFrame: null,
      confirmedPresentedFrame: 43,
      expectedMotion: true,
      actualPlayback: "playing",
    });
  });

  it("does not let pointerup or change reset the captured target", () => {
    const model = ready("c");
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 57 });
    model.dispatch({ type: "scrub-pointerup", atMs: 110, frame: 0 });
    model.dispatch({ type: "scrub-change", atMs: 111, frame: 0 });

    expect(model.snapshot(111)).toMatchObject({
      intendedFrame: 57,
      seekTargetFrame: 57,
      scrubHeldFrame: null,
      seeking: true,
      reason: "resume-requested",
      resumeRequested: true,
    });
    expect(model.snapshot(111).eventTape.at(-1)).toMatchObject({
      event: "scrub-change",
      details: { ignoredFrame: 0, intendedFrame: 57, resumeRequested: true },
    });
  });

  it("makes an explicit user pause the only intentional paused reason after scrub", () => {
    const model = ready();
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 24 });
    model.dispatch({ type: "scrub-change", atMs: 110, frame: 0 });
    model.dispatch({ type: "media-playing", atMs: 115 });
    model.dispatch({ type: "media-presented", atMs: 120, frame: 24, currentTimeSeconds: 1.6 });
    expect(model.snapshot(120).actualPlayback).toBe("playing");

    model.dispatch({ type: "user-pause", atMs: 130 });
    expect(model.snapshot(130)).toMatchObject({
      expectedMotion: false,
      actualPlayback: "paused",
      reason: "user-pause",
      resumeRequested: false,
    });
  });

  it("reports an observational timeout without falsifying actual playback", () => {
    const model = ready();
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 90 });
    model.dispatch({ type: "scrub-pointerup", atMs: 110, frame: 0 });
    model.dispatch({ type: "media-playing", atMs: 120 });

    expect(model.snapshot(599)).toMatchObject({
      seeking: true,
      reason: "media-playing",
      lastProgressAgeMs: 599,
    });
    expect(model.snapshot(601)).toMatchObject({
      intendedFrame: 90,
      scrubHeldFrame: null,
      seekTargetFrame: 90,
      targetConfirmedFrame: null,
      seeking: false,
      expectedMotion: true,
      actualPlayback: "playing",
      reason: "target-confirmation-timeout",
      resumeRequested: false,
      targetConfirmationTimedOut: true,
      lastProgressAgeMs: 601,
    });

    // A decoder may skip the exact requested PTS once playback resumes. The
    // first later presentation is still useful evidence and clears timeout.
    model.dispatch({ type: "media-presented", atMs: 650, frame: 92, currentTimeSeconds: 92 / 15, source: "rvfc" });
    expect(model.snapshot(650)).toMatchObject({
      targetConfirmedFrame: 92,
      postSeekProgressFrame: 92,
      deltaFrames: 2,
      targetConfirmationTimedOut: false,
      actualPlayback: "playing",
    });
  });

  it("preserves target and motion intent when a renderer falls back", () => {
    const model = ready("a");
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 66 });
    model.dispatch({ type: "scrub-pointerup", atMs: 110, frame: 0 });
    model.dispatch({ type: "renderer-fallback", atMs: 130, from: "a", to: "b" });

    expect(model.snapshot(130)).toMatchObject({
      renderer: "b",
      intendedFrame: 66,
      seekTargetFrame: 66,
      scrubHeldFrame: null,
      seeking: true,
      expectedMotion: true,
      actualPlayback: "paused",
      reason: "fallback-a-to-b",
      resumeRequested: true,
    });
    expect(model.snapshot(130).eventTape.at(-1)).toMatchObject({
      event: "renderer-fallback",
      details: { from: "a", to: "b", intendedFrame: 66 },
    });
    expect(shouldAutoplayHandoff(model.snapshot(130))).toBe(true);

    const explicitlyPaused = ready("a");
    explicitlyPaused.dispatch({ type: "user-pause", atMs: 100 });
    explicitlyPaused.dispatch({ type: "renderer-fallback", atMs: 110, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(explicitlyPaused.snapshot(110))).toBe(false);
  });

  it("keeps frame PTS mapping bounded at the final frame", () => {
    const model = ready();
    model.dispatch({ type: "media-presented", atMs: 40, frame: 149, currentTimeSeconds: 149 / 15, source: "rvfc" });
    expect(model.snapshot(40)).toMatchObject({ mediaFrame: 149, confirmedPresentedFrame: 149 });
  });

  it("chooses fresh autoplay but preserves paused and active handoff intent", () => {
    const fresh = createVideoPlaybackModel({ renderer: "b", frameCount: 150, frameRate: 15 });
    expect(shouldAutoplayHandoff(fresh.snapshot())).toBe(true);

    const paused = ready();
    paused.dispatch({ type: "media-presented", atMs: 40, frame: 55, currentTimeSeconds: 55 / 15, source: "rvfc" });
    paused.dispatch({ type: "user-pause", atMs: 100 });
    paused.dispatch({ type: "renderer-fallback", atMs: 110, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(paused.snapshot(110))).toBe(false);
    expect(playbackHandoffFrame(paused.snapshot(110))).toBe(55);

    const stalled = ready();
    stalled.dispatch({ type: "scrub-input", atMs: 100, frame: 88 });
    stalled.dispatch({ type: "scrub-pointerup", atMs: 110, frame: 0 });
    stalled.snapshot(601);
    stalled.dispatch({ type: "renderer-fallback", atMs: 610, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(stalled.snapshot(610))).toBe(true);
    expect(playbackHandoffFrame(stalled.snapshot(610))).toBe(88);

    const active = ready();
    active.dispatch({ type: "media-presented", atMs: 40, frame: 1, currentTimeSeconds: 1 / 15, source: "rvfc" });
    active.dispatch({ type: "renderer-fallback", atMs: 50, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(active.snapshot(50))).toBe(true);
  });
});

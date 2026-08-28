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
        expectedMotion: true,
        actualPlayback: "playing",
        reason: "autoplay-t0",
      });
    }
  });

  it("captures a scrub target and auto-resumes after its frame is confirmed", () => {
    const model = ready();

    model.dispatch({ type: "scrub-input", atMs: 100, frame: 42 });
    expect(model.snapshot(100)).toMatchObject({
      intendedFrame: 42,
      scrubHeldFrame: 42,
      seeking: true,
      expectedMotion: true,
      actualPlayback: "paused",
      reason: "seeking",
    });

    model.dispatch({ type: "media-presented", atMs: 140, frame: 42, currentTimeSeconds: 2.8, source: "seeked-estimate" });
    expect(model.snapshot(140)).toMatchObject({
      intendedFrame: 42,
      mediaCurrentTimeSeconds: 2.8,
      mediaFrame: 42,
      confirmedPresentedFrame: 42,
      confirmationSource: "seeked-estimate",
      deltaFrames: 0,
      scrubHeldFrame: null,
      seeking: false,
      expectedMotion: true,
      actualPlayback: "playing",
      reason: "scrub-confirmed-autoplay",
    });

    model.dispatch({ type: "media-presented", atMs: 173, frame: 43, currentTimeSeconds: 2.866 });
    expect(model.snapshot(173)).toMatchObject({
      confirmedPresentedFrame: 43,
      deltaFrames: 1,
      expectedMotion: true,
      actualPlayback: "playing",
    });
    expect(model.snapshot(173).eventTape.map((entry) => entry.event)).toEqual([
      "media-ready",
      "scrub-input",
      "media-presented",
      "media-presented",
    ]);

    model.dispatch({ type: "scrub-pointerup", atMs: 180, frame: 0 });
    model.dispatch({ type: "scrub-change", atMs: 181, frame: 0 });
    expect(model.snapshot(181)).toMatchObject({
      intendedFrame: 42,
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
      scrubHeldFrame: 57,
      seeking: true,
      reason: "seeking",
    });
  });

  it("makes an explicit user pause the only intentional paused reason after scrub", () => {
    const model = ready();
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 24 });
    model.dispatch({ type: "media-presented", atMs: 120, frame: 24, currentTimeSeconds: 1.6 });
    expect(model.snapshot(120).actualPlayback).toBe("playing");

    model.dispatch({ type: "user-pause", atMs: 130 });
    expect(model.snapshot(130)).toMatchObject({
      expectedMotion: false,
      actualPlayback: "paused",
      reason: "user-pause",
    });
  });

  it("reports stalled-after-seek when no presented frame arrives by the resume deadline", () => {
    const model = ready();
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 90 });

    expect(model.snapshot(599)).toMatchObject({
      seeking: true,
      reason: "seeking",
      lastProgressAgeMs: 599,
    });
    expect(model.snapshot(601)).toMatchObject({
      intendedFrame: 90,
      scrubHeldFrame: 90,
      seeking: false,
      expectedMotion: true,
      actualPlayback: "paused",
      reason: "stalled-after-seek",
      lastProgressAgeMs: 601,
    });
  });

  it("preserves target and motion intent when a renderer falls back", () => {
    const model = ready("a");
    model.dispatch({ type: "scrub-input", atMs: 100, frame: 66 });
    model.dispatch({ type: "renderer-fallback", atMs: 130, from: "a", to: "b" });

    expect(model.snapshot(130)).toMatchObject({
      renderer: "b",
      intendedFrame: 66,
      scrubHeldFrame: 66,
      seeking: true,
      expectedMotion: true,
      reason: "fallback-a-to-b",
    });
    expect(model.snapshot(130).eventTape.at(-1)).toMatchObject({
      event: "renderer-fallback",
      details: { from: "a", to: "b", intendedFrame: 66 },
    });
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
    stalled.snapshot(601);
    stalled.dispatch({ type: "renderer-fallback", atMs: 610, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(stalled.snapshot(610))).toBe(false);
    expect(playbackHandoffFrame(stalled.snapshot(610))).toBe(88);

    const active = ready();
    active.dispatch({ type: "media-presented", atMs: 40, frame: 1, currentTimeSeconds: 1 / 15, source: "rvfc" });
    active.dispatch({ type: "renderer-fallback", atMs: 50, from: "a", to: "b" });
    expect(shouldAutoplayHandoff(active.snapshot(50))).toBe(true);
  });
});

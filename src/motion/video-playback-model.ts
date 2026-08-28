/**
 * PROTOTYPE ONLY — renderer-independent playback state seam.
 *
 * The browser adapters feed this small model facts from media events. The
 * model owns motion intent, scrub handoff, stall detection, and the public
 * event tape so A/B/C can be compared without relying on a particular media
 * API or browser event ordering.
 */

export type PlaybackRenderer = "a" | "b" | "c";
export type ActualPlayback = "paused" | "playing";

export type PlaybackEvent =
  | { type: "media-ready"; atMs: number; durationSeconds: number; currentTimeSeconds?: number }
  | { type: "media-timeupdate"; atMs: number; currentTimeSeconds: number }
  | { type: "media-presented"; atMs: number; frame: number; currentTimeSeconds: number; source?: string }
  | { type: "scrub-input"; atMs: number; frame: number }
  | { type: "scrub-pointerup"; atMs: number; frame?: number }
  | { type: "scrub-change"; atMs: number; frame?: number }
  | { type: "user-play"; atMs: number }
  | { type: "user-pause"; atMs: number }
  | { type: "media-playing"; atMs: number }
  | { type: "media-paused"; atMs: number; reason?: string }
  | { type: "renderer-fallback"; atMs: number; from: PlaybackRenderer; to: PlaybackRenderer };

export type PlaybackTapeDetails = Readonly<Record<string, string | number | boolean | null>>;

export type PlaybackTapeEntry = {
  atMs: number;
  event: PlaybackEvent["type"];
  details: PlaybackTapeDetails;
};

export type VideoPlaybackSnapshot = {
  renderer: PlaybackRenderer;
  durationSeconds: number | null;
  intendedFrame: number;
  mediaCurrentTimeSeconds: number | null;
  mediaFrame: number | null;
  confirmedPresentedFrame: number | null;
  confirmationSource: string | null;
  deltaFrames: number | null;
  expectedMotion: boolean;
  actualPlayback: ActualPlayback;
  reason: string;
  lastProgressAtMs: number | null;
  lastProgressAgeMs: number | null;
  scrubHeldFrame: number | null;
  seeking: boolean;
  eventTape: readonly PlaybackTapeEntry[];
};

export type VideoPlaybackModel = {
  dispatch(event: PlaybackEvent): VideoPlaybackSnapshot;
  snapshot(atMs?: number): VideoPlaybackSnapshot;
};

export type VideoPlaybackModelOptions = {
  renderer: PlaybackRenderer;
  frameCount: number;
  frameRate: number;
  resumeDeadlineMs?: number;
  tapeLimit?: number;
};

/**
 * Decide whether a renderer may start after a fallback handoff. A model that
 * has not reached media-ready is a fresh attempt and should autoplay; once a
 * ready renderer has handed off, preserve its actual paused/playing state and
 * motion intent exactly.
 */
export function shouldAutoplayHandoff(snapshot: VideoPlaybackSnapshot): boolean {
  const hasMediaReady = snapshot.eventTape.some((entry) => entry.event === "media-ready");
  if (!hasMediaReady) return true;
  return snapshot.expectedMotion
    && snapshot.actualPlayback === "playing"
    && !snapshot.seeking
    && snapshot.reason !== "user-pause"
    && snapshot.reason !== "stalled-after-seek";
}

/** Keep the last known frame when a renderer changes, including a paused one. */
export function playbackHandoffFrame(snapshot: VideoPlaybackSnapshot): number {
  return snapshot.scrubHeldFrame ?? snapshot.confirmedPresentedFrame ?? snapshot.intendedFrame;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clampFrame(frame: number, frameCount: number): number {
  return Math.max(0, Math.min(frameCount - 1, Math.round(frame)));
}

function frameFromTime(currentTimeSeconds: number, frameRate: number, frameCount: number): number {
  if (!Number.isFinite(currentTimeSeconds) || !Number.isFinite(frameRate) || frameRate <= 0) return 0;
  // The sequence's presentation timestamps are frame / frameRate. Rounding
  // gives a bounded half-frame tolerance for decoder timestamp quantization.
  return clampFrame(currentTimeSeconds * frameRate, frameCount);
}

function assertOptions(options: VideoPlaybackModelOptions): void {
  if (!Number.isInteger(options.frameCount) || options.frameCount < 2) throw new RangeError("frameCount must be at least 2");
  if (!Number.isFinite(options.frameRate) || options.frameRate <= 0) throw new RangeError("frameRate must be positive");
  const deadline = finiteOr(options.resumeDeadlineMs, 500);
  if (deadline <= 0) throw new RangeError("resumeDeadlineMs must be positive");
  const tapeLimit = finiteOr(options.tapeLimit, 64);
  if (!Number.isInteger(tapeLimit) || tapeLimit < 1) throw new RangeError("tapeLimit must be a positive integer");
}

/**
 * Creates the public playback model used by the prototype's native video,
 * packed WebGL video, and WebP-sequence adapters.
 */
export function createVideoPlaybackModel(options: VideoPlaybackModelOptions): VideoPlaybackModel {
  assertOptions(options);
  const frameCount = options.frameCount;
  const frameRate = options.frameRate;
  const resumeDeadlineMs = finiteOr(options.resumeDeadlineMs, 500);
  const tapeLimit = finiteOr(options.tapeLimit, 64);
  let renderer = options.renderer;
  let durationSeconds: number | null = null;
  let intendedFrame = 0;
  let mediaCurrentTimeSeconds: number | null = null;
  let mediaFrame: number | null = null;
  let confirmedPresentedFrame: number | null = null;
  let confirmationSource: string | null = null;
  let expectedMotion = false;
  let actualPlayback: ActualPlayback = "paused";
  let reason = "mount";
  let lastProgressAtMs: number | null = null;
  let scrubHeldFrame: number | null = null;
  let seeking = false;
  let seekDeadlineAtMs: number | null = null;
  let userPaused = false;
  const eventTape: PlaybackTapeEntry[] = [];

  const appendTape = (event: PlaybackEvent, details: PlaybackTapeDetails = {}): void => {
    eventTape.push({ atMs: event.atMs, event: event.type, details });
    while (eventTape.length > tapeLimit) eventTape.shift();
  };

  const setMediaTime = (currentTimeSeconds: number): void => {
    mediaCurrentTimeSeconds = Number.isFinite(currentTimeSeconds) ? currentTimeSeconds : null;
    mediaFrame = mediaCurrentTimeSeconds === null || durationSeconds === null
      ? null
      : frameFromTime(mediaCurrentTimeSeconds, frameRate, frameCount);
  };

  const snapshot = (atMs = lastProgressAtMs ?? 0): VideoPlaybackSnapshot => {
    if (seeking && seekDeadlineAtMs !== null && atMs >= seekDeadlineAtMs && !userPaused) {
      seeking = false;
      actualPlayback = "paused";
      expectedMotion = true;
      reason = "stalled-after-seek";
      appendTape(
        { type: "media-timeupdate", atMs, currentTimeSeconds: mediaCurrentTimeSeconds ?? 0 },
        { synthetic: true, reason },
      );
      seekDeadlineAtMs = null;
    }
    const lastProgressAgeMs = lastProgressAtMs === null ? null : Math.max(0, atMs - lastProgressAtMs);
    return {
      renderer,
      durationSeconds,
      intendedFrame,
      mediaCurrentTimeSeconds,
      mediaFrame,
      confirmedPresentedFrame,
      confirmationSource,
      deltaFrames: confirmedPresentedFrame === null ? null : confirmedPresentedFrame - intendedFrame,
      expectedMotion,
      actualPlayback,
      reason,
      lastProgressAtMs,
      lastProgressAgeMs,
      scrubHeldFrame,
      seeking,
      eventTape: eventTape.map((entry) => ({ ...entry, details: { ...entry.details } })),
    };
  };

  const dispatch = (event: PlaybackEvent): VideoPlaybackSnapshot => {
    if (!Number.isFinite(event.atMs) || event.atMs < 0) throw new RangeError("playback event time must be finite and non-negative");
    switch (event.type) {
      case "media-ready": {
        durationSeconds = Number.isFinite(event.durationSeconds) && event.durationSeconds > 0 ? event.durationSeconds : null;
        setMediaTime(event.currentTimeSeconds ?? 0);
        expectedMotion = true;
        actualPlayback = "playing";
        userPaused = false;
        seeking = false;
        scrubHeldFrame = null;
        seekDeadlineAtMs = null;
        confirmationSource = null;
        reason = "autoplay-t0";
        lastProgressAtMs = event.atMs;
        appendTape(event, { currentTimeSeconds: mediaCurrentTimeSeconds, intendedFrame: 0, autoplay: true });
        break;
      }
      case "media-timeupdate": {
        setMediaTime(event.currentTimeSeconds);
        appendTape(event, { mediaFrame, currentTimeSeconds: mediaCurrentTimeSeconds });
        break;
      }
      case "media-presented": {
        const presentedFrame = clampFrame(event.frame, frameCount);
        setMediaTime(event.currentTimeSeconds);
        if (!userPaused) {
          confirmedPresentedFrame = presentedFrame;
          confirmationSource = event.source ?? "event";
          lastProgressAtMs = event.atMs;
          if (seeking && scrubHeldFrame === presentedFrame) {
            seeking = false;
            scrubHeldFrame = null;
            seekDeadlineAtMs = null;
            expectedMotion = true;
            actualPlayback = "playing";
            reason = "scrub-confirmed-autoplay";
          } else if (expectedMotion) {
            actualPlayback = "playing";
            reason = "presented-progress";
          }
        }
        appendTape(event, {
          frame: presentedFrame,
          currentTimeSeconds: mediaCurrentTimeSeconds,
          source: event.source ?? null,
          confirmed: !userPaused,
          intendedFrame,
        });
        break;
      }
      case "scrub-input": {
        const target = clampFrame(event.frame, frameCount);
        intendedFrame = target;
        scrubHeldFrame = target;
        seeking = true;
        seekDeadlineAtMs = event.atMs + resumeDeadlineMs;
        if (!userPaused) expectedMotion = true;
        actualPlayback = "paused";
        reason = userPaused ? "user-pause" : "seeking";
        appendTape(event, { frame: target, intendedFrame, expectedMotion });
        break;
      }
      case "scrub-pointerup":
      case "scrub-change": {
        // Pointer lifecycle events are acknowledgements only. The last input
        // event is the source of truth; stale frame=0 values are recorded but
        // cannot mutate the intended target.
        appendTape(event, {
          ignoredFrame: event.frame ?? null,
          intendedFrame,
          scrubHeldFrame,
        });
        break;
      }
      case "user-pause": {
        userPaused = true;
        expectedMotion = false;
        actualPlayback = "paused";
        seeking = false;
        reason = "user-pause";
        seekDeadlineAtMs = null;
        appendTape(event, { intendedFrame, userPaused: true });
        break;
      }
      case "user-play": {
        userPaused = false;
        expectedMotion = true;
        actualPlayback = "playing";
        seeking = false;
        scrubHeldFrame = null;
        seekDeadlineAtMs = null;
        reason = "user-play";
        appendTape(event, { intendedFrame, resumed: true });
        break;
      }
      case "media-playing": {
        if (!userPaused) {
          actualPlayback = "playing";
          expectedMotion = true;
          if (reason !== "autoplay-t0" && reason !== "scrub-confirmed-autoplay") reason = "media-playing";
        }
        appendTape(event, { actualPlayback, expectedMotion, userPaused });
        break;
      }
      case "media-paused": {
        actualPlayback = "paused";
        const mediaReason = event.reason ?? "media-paused";
        if (mediaReason === "user-pause") {
          userPaused = true;
          expectedMotion = false;
          seeking = false;
          scrubHeldFrame = null;
          seekDeadlineAtMs = null;
          reason = "user-pause";
        } else {
          reason = mediaReason;
        }
        appendTape(event, { actualPlayback, expectedMotion, reason, userPaused });
        break;
      }
      case "renderer-fallback": {
        renderer = event.to;
        reason = `fallback-${event.from}-to-${event.to}`;
        expectedMotion = expectedMotion || !userPaused;
        actualPlayback = seeking || userPaused ? "paused" : actualPlayback;
        appendTape(event, { from: event.from, to: event.to, intendedFrame, expectedMotion });
        break;
      }
    }
    return snapshot(event.atMs);
  };

  return { dispatch, snapshot };
}

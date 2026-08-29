import { HERO_CONTRACT, type HeroPhase } from "./hero-contract";

export type NativePresentedPhase = "intro" | "playing" | "complete";

export type NativePresentedTimelineSample = Readonly<{
  /** Frame that actually reached the media presentation path. */
  frame: number;
  phase: NativePresentedPhase;
  /** Elapsed time in the current authored segment, derived from mediaTime. */
  phaseElapsedMs: number;
  playbackCompleted: boolean;
}>;

export type NativeTimelineProjectionGateInput = Readonly<{
  nativeActive: boolean;
  nativeVisible: boolean;
  nativeStopped: boolean;
  documentVisible: boolean;
  heroVisible: boolean;
  phase: HeroPhase;
}>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeElapsed(value: number): number {
  // `31 / 15 * 15` is not guaranteed to round-trip to exactly 31 on every
  // JavaScript engine.  Frame zero and the segment boundary are semantic
  // points, so do not leak a sub-pixel floating-point remainder into the
  // diagnostic clock or cue reducer.
  return Math.abs(value) < 1e-9 ? 0 : value;
}

/**
 * rVFC can arrive after visibility changes have paused/deactivated a scene.
 * Such a callback is still useful as raw media evidence, but must not project
 * into the application timeline until the native surface is active and the
 * hero is visible again.
 */
export function shouldProjectNativeTimeline(
  input: NativeTimelineProjectionGateInput,
): boolean {
  return input.nativeActive
    && input.nativeVisible
    && !input.nativeStopped
    && input.documentVisible
    && input.heroVisible
    && (input.phase === "intro" || input.phase === "playing");
}

/**
 * Project one rVFC `mediaTime` into the application timeline.
 *
 * This is intentionally a projection, not a second clock: the caller must
 * invoke it only for an actual presented-frame callback. The native media
 * element remains the authority for frame progress.
 */
export function sampleNativeTimeline(
  mediaTimeSeconds: number,
  frameRate = 15,
): NativePresentedTimelineSample {
  if (!Number.isFinite(mediaTimeSeconds) || mediaTimeSeconds < 0) {
    throw new RangeError("Native media time must be finite and non-negative");
  }
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new RangeError("Native frame rate must be positive");
  }
  const mediaFrame = clamp(
    mediaTimeSeconds * frameRate,
    HERO_CONTRACT.startFrame,
    HERO_CONTRACT.endFrame,
  );
  const frame = Math.round(mediaFrame);
  if (frame >= HERO_CONTRACT.endFrame) {
    return {
      frame: HERO_CONTRACT.endFrame,
      phase: "complete",
      phaseElapsedMs: HERO_CONTRACT.playbackDurationMs,
      playbackCompleted: true,
    };
  }
  if (frame >= HERO_CONTRACT.introEndFrame) {
    return {
      frame,
      phase: "playing",
      phaseElapsedMs: normalizeElapsed(Math.max(
        0,
        ((mediaFrame - HERO_CONTRACT.introEndFrame)
          / (HERO_CONTRACT.endFrame - HERO_CONTRACT.introEndFrame))
          * HERO_CONTRACT.playbackDurationMs,
      )),
      playbackCompleted: false,
    };
  }
  return {
    frame,
    phase: "intro",
    phaseElapsedMs: normalizeElapsed(Math.max(
      0,
      (mediaFrame / (HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame))
        * HERO_CONTRACT.introDurationMs,
    )),
    playbackCompleted: false,
  };
}

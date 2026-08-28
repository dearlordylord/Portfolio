/**
 * Native media clock policy.
 *
 * The browser video is the only playback clock during timed hero phases. The
 * application samples its linear contract for copy/canvas state, but must not
 * repeatedly seek the media element toward that sample. Seeks are reserved
 * for initial positioning and settled/intentional positions.
 */

export type NativePlaybackSyncPhase =
  | "intro"
  | "playing"
  | "ready"
  | "complete"
  | "exit-hold"
  | "released"
  | "reduced";

export type NativePlaybackSyncInput = Readonly<{
  phase: NativePlaybackSyncPhase;
  currentTimeSeconds: number | null;
  targetTimeSeconds: number;
  desiredPlaybackRate: number;
  currentPlaybackRate: number | null;
  phaseChanged: boolean;
  /** False only for the one initial-positioning decision. */
  initialPositioned: boolean;
  paused: boolean;
  /** A native presentation watchdog is measuring a possible underflow. */
  recoverySuppressed: boolean;
}>;

export type NativePlaybackSyncDecision = Readonly<{
  seekToSeconds: number | null;
  setPlaybackRate: number | null;
  play: boolean;
  pause: boolean;
  reason: "initial-position" | "phase-rate-change" | "healthy-clock" | "settled-position" | "settled";
}>;

/** Sub-frame tolerance for an already-positioned media element. */
export const NATIVE_PLAYBACK_POSITION_EPSILON_SECONDS = 1 / 120;
const NATIVE_PLAYBACK_RATE_EPSILON = 1 / 1_000_000;

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requiresPosition(current: number | null, target: number): boolean {
  return current === null || Math.abs(current - target) > NATIVE_PLAYBACK_POSITION_EPSILON_SECONDS;
}

/** Return the only media commands allowed for the current contract phase. */
export function decideNativePlaybackSync(
  input: NativePlaybackSyncInput,
): NativePlaybackSyncDecision {
  assertFinite("Native target time", input.targetTimeSeconds);
  assertFinite("Native desired playback rate", input.desiredPlaybackRate);
  if (input.targetTimeSeconds < 0 || input.desiredPlaybackRate <= 0) {
    throw new RangeError("Native target time and playback rate must be positive");
  }
  if (input.currentTimeSeconds !== null) assertFinite("Native current time", input.currentTimeSeconds);
  if (input.currentPlaybackRate !== null) assertFinite("Native current playback rate", input.currentPlaybackRate);

  const timed = input.phase === "intro" || input.phase === "playing";
  if (timed) {
    const seekToSeconds = !input.initialPositioned && requiresPosition(input.currentTimeSeconds, input.targetTimeSeconds)
      ? input.targetTimeSeconds
      : null;
    const rateChanged = input.currentPlaybackRate === null
      || Math.abs(input.currentPlaybackRate - input.desiredPlaybackRate) > NATIVE_PLAYBACK_RATE_EPSILON;
    return {
      seekToSeconds,
      setPlaybackRate: rateChanged ? input.desiredPlaybackRate : null,
      play: input.paused && !input.recoverySuppressed,
      pause: false,
      reason: seekToSeconds !== null
        ? "initial-position"
        : rateChanged
          ? "phase-rate-change"
          : "healthy-clock",
    };
  }

  const seekToSeconds = requiresPosition(input.currentTimeSeconds, input.targetTimeSeconds)
    ? input.targetTimeSeconds
    : null;
  return {
    seekToSeconds,
    setPlaybackRate: null,
    play: false,
    pause: true,
    reason: seekToSeconds === null ? "settled" : "settled-position",
  };
}

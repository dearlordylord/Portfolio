/**
 * Deterministic post-readiness progress guard for the production native
 * renderers (A and H).
 *
 * A and H are direct DOM videos, so preparation can pass while a later range
 * underflow stops presented frames. This model deliberately knows only about
 * observed presentation, visual motion intent, and media recovery signals. The
 * browser adapter owns the fallback side effect; this module makes the timing
 * boundary independently testable.
 */

/** Native media is authored at 15fps; 750ms allows roughly eleven missed frames. */
export const HERO_NATIVE_H_FRAME_RATE = 15;
export const HERO_NATIVE_H_UNDERFLOW_GRACE_MS = 750;
/** Canonical renderer-neutral names; H aliases remain for existing consumers. */
export const HERO_NATIVE_FRAME_RATE = HERO_NATIVE_H_FRAME_RATE;
export const HERO_NATIVE_UNDERFLOW_GRACE_MS = HERO_NATIVE_H_UNDERFLOW_GRACE_MS;

export type NativeHWatchdogStatus = "inactive" | "monitoring" | "tripped";

export type NativeHWatchdogState = Readonly<{
  status: NativeHWatchdogStatus;
  lastPresentedFrame: number | null;
  lastProgressAtMs: number | null;
  noProgressSinceMs: number | null;
  waiting: boolean;
  stalled: boolean;
}>;

/** Renderer-neutral aliases used by the production adapter. */
export type NativeWatchdogStatus = NativeHWatchdogStatus;
export type NativeWatchdogState = NativeHWatchdogState;

export type NativeHWatchdogObservation = Readonly<{
  atMs: number;
  /** True only while the accepted native candidate remains the active surface. */
  active: boolean;
  /** True only while the app expects the visible media frame to advance. */
  motionExpected: boolean;
  /** Settled/at-target states are never treated as underflow. */
  atTarget: boolean;
  /** Frame reported by rVFC; media events never count as presentation. */
  presentedFrame: number | null;
  /** Media events are evidence, not a prerequisite for the no-progress guard. */
  waiting?: boolean;
  stalled?: boolean;
  /** `playing`, `progress`, or another media recovery signal. */
  recovery?: boolean;
}>;

export type NativeHWatchdogResult = Readonly<{
  state: NativeHWatchdogState;
  action: "none" | "fallback";
  reason:
    | "inactive"
    | "armed"
    | "monitoring"
    | "presented-progress"
    | "media-recovery"
    | "underflow-grace-exceeded";
}>;

export type NativeWatchdogObservation = NativeHWatchdogObservation;
export type NativeWatchdogResult = NativeHWatchdogResult;

export function initialNativeHWatchdogState(): NativeHWatchdogState {
  return {
    status: "inactive",
    lastPresentedFrame: null,
    lastProgressAtMs: null,
    noProgressSinceMs: null,
    waiting: false,
    stalled: false,
  };
}

function assertObservation(observation: NativeHWatchdogObservation, graceMs: number): void {
  if (!Number.isFinite(observation.atMs) || observation.atMs < 0) {
    throw new RangeError("Native watchdog time must be finite and non-negative");
  }
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new RangeError("Native watchdog grace must be positive");
  }
  if (
    observation.presentedFrame !== null
    && (!Number.isFinite(observation.presentedFrame) || observation.presentedFrame < 0)
  ) {
    throw new RangeError("Native presented frame must be finite and non-negative");
  }
}

function inactiveResult(): NativeHWatchdogResult {
  return {
    state: initialNativeHWatchdogState(),
    action: "none",
    reason: "inactive",
  };
}

/**
 * Advance the native watchdog with one observed media/scheduler sample.
 *
 * A strictly forward presented frame resets the grace window. A repeated
 * frame does not count as progress, even if `timeupdate` keeps firing. The
 * adapter supplies `motionExpected=false` for intentional pauses, settled
 * phases, visibility loss, reduced motion, and navigation, so those states
 * reset the model instead of accumulating a false underflow.
 */
export function advanceNativeHWatchdog(
  previous: NativeHWatchdogState,
  observation: NativeHWatchdogObservation,
  graceMs = HERO_NATIVE_H_UNDERFLOW_GRACE_MS,
): NativeHWatchdogResult {
  assertObservation(observation, graceMs);
  if (!observation.active || !observation.motionExpected || observation.atTarget) {
    return inactiveResult();
  }

  const atMs = observation.atMs;
  const previousFrame = previous.lastPresentedFrame;
  const presentedFrame = observation.presentedFrame;
  const presentedProgress = presentedFrame !== null
    && (previousFrame === null || presentedFrame > previousFrame);

  if (presentedProgress) {
    return {
      state: {
        status: "monitoring",
        lastPresentedFrame: presentedFrame,
        lastProgressAtMs: atMs,
        noProgressSinceMs: null,
        waiting: false,
        stalled: false,
      },
      action: "none",
      reason: "presented-progress",
    };
  }

  const lastProgressAtMs = previous.lastProgressAtMs ?? atMs;
  const noProgressSinceMs = previous.noProgressSinceMs ?? lastProgressAtMs;
  // Media `progress`, `playing`, and `canplay` events are useful evidence
  // that the element is active, but none proves that a new frame reached the
  // screen. They may clear a stale waiting/stalled flag; the presentation
  // deadline remains anchored to the last strictly forward frame above.
  const recovery = observation.recovery === true;
  const state: NativeHWatchdogState = {
    status: "monitoring",
    lastPresentedFrame: presentedFrame ?? previousFrame,
    lastProgressAtMs,
    noProgressSinceMs,
    waiting: recovery ? false : previous.waiting || observation.waiting === true,
    stalled: recovery ? false : previous.stalled || observation.stalled === true,
  };
  if (atMs - lastProgressAtMs < graceMs) {
    return {
      state,
      action: "none",
      reason: recovery
        ? "media-recovery"
        : previous.status === "inactive"
          ? "armed"
          : "monitoring",
    };
  }
  return {
    state: { ...state, status: "tripped" },
    action: "fallback",
    reason: "underflow-grace-exceeded",
  };
}

/** Renderer-neutral entry points. The H-suffixed exports above are retained as
 * a compatibility surface for existing diagnostics and tests. */
export const initialNativeWatchdogState = initialNativeHWatchdogState;
export const advanceNativeWatchdog = advanceNativeHWatchdog;

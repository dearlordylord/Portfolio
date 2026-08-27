import { rect, type Rect } from "./types";

export const HERO_PHASES = [
  "loading",
  "intro",
  "ready",
  "playing",
  "complete",
  "exit-hold",
  "released",
  "reduced",
] as const;
export type HeroPhase = (typeof HERO_PHASES)[number];

export const HERO_CUES = ["role", "experience", "cta"] as const;
export type HeroCue = (typeof HERO_CUES)[number];

/** The timeline constants are shared by the renderer and pure tests. */
export const HERO_CONTRACT = Object.freeze({
  totalFrameCount: 150,
  startFrame: 0,
  introEndFrame: 31,
  endFrame: 149,
  introDurationMs: 1400,
  playbackDurationMs: 3500,
  driftFrames: 8,
  exitHoldDurationMs: 750,
});

export const MOBILE_HERO_CONTRACT = Object.freeze({
  boundaryRatio: 0.85,
  stageTopRatio: 0.38,
  copyTopRatio: 0.09,
  desktopCopyTopRatio: 0.38,
  hintOffset: 62,
  maxCanvasDpr: 2,
  // Mobile groups occupy one slot. The role reaches zero exactly when the
  // experience begins, so replacement never renders both groups at once.
  role: { fadeIn: 5, peak: 14, fadeOut: 48, end: 58 },
  experience: { fadeIn: 58, peak: 72, fadeOut: 128, end: 145 },
  ctaAvailableTargetFrame: 128,
});

/**
 * The breakpoint is a layout token as well as a browser-adapter concern.  A
 * caller can still pass an explicit mode to make a contract sample stable at
 * the exact breakpoint (`768px` is mobile in the page CSS).
 */
export const HERO_LAYOUT_CONTRACT = Object.freeze({
  breakpoint: 768,
  boundaryRatio: MOBILE_HERO_CONTRACT.boundaryRatio,
  mobileStageTopRatio: MOBILE_HERO_CONTRACT.stageTopRatio,
  mobileCopyTopRatio: MOBILE_HERO_CONTRACT.copyTopRatio,
  desktopStageTopRatio: 0,
  desktopCopyTopRatio: MOBILE_HERO_CONTRACT.desktopCopyTopRatio,
  aboutOverlapRatio: 1 - MOBILE_HERO_CONTRACT.boundaryRatio,
  hintOffset: MOBILE_HERO_CONTRACT.hintOffset,
  maxCanvasDpr: MOBILE_HERO_CONTRACT.maxCanvasDpr,
});

export type HeroCTAState = "unavailable" | "available";
export type HeroCtaState = HeroCTAState;

export type HeroCTASample = {
  state: HeroCTAState;
  available: boolean;
  opacity: number;
  pointerEvents: "none" | "all";
};

export type HeroPresentationSample = {
  roleOpacity: number;
  experienceOpacity: number;
  cue: HeroCue | null;
  ctaAvailable: boolean;
  cta: HeroCTASample;
};

export type HeroTimelineSample = {
  targetFrame: number;
  progress: number;
};

export type HeroPhaseEvent =
  | "assets-ready"
  | "intro-complete"
  | "advance"
  | "playback-complete"
  | "request-exit"
  | "exit-delay-complete"
  | "cancel-exit"
  | "release"
  | "reduced-motion";

export type HeroLayoutMode = "mobile" | "desktop";

export type StableMobileHeroInput = {
  width: number;
  visualHeight: number;
  stableHeight: number;
  dpr: number;
};

export type HeroLayoutInput = StableMobileHeroInput & {
  mode?: HeroLayoutMode;
};

export type HeroAnchor = { x: number; y: number };

export type HeroLayout = {
  mode: HeroLayoutMode;
  firstScreen: Rect;
  /** The shared centered copy slot (mobile) and its desktop-safe baseline. */
  copyAnchor: HeroAnchor;
  /** Desktop copy anchors are explicit even though CSS supplies side offsets. */
  copyAnchors: {
    role: HeroAnchor;
    experience: HeroAnchor;
  };
  stage: Rect;
  /** Canvas is the same rectangle as the motion stage by contract. */
  canvas: Rect;
  boundaryY: number;
  boundary: Rect;
  ctaAnchor: HeroAnchor;
  hintAnchor: HeroAnchor;
  /** Amount by which About overlaps the stable first screen. */
  aboutOverlap: number;
  backingStore: { width: number; height: number; effectiveDpr: number };
};

/** Backwards-compatible name for existing mobile callers. */
export type StableMobileHeroLayout = HeroLayout;

function opacity(frame: number, cue: typeof MOBILE_HERO_CONTRACT.role): number {
  if (frame < cue.fadeIn || frame > cue.end) return 0;
  if (frame < cue.peak) return (frame - cue.fadeIn) / (cue.peak - cue.fadeIn);
  if (frame < cue.fadeOut) return 1;
  return 1 - (frame - cue.fadeOut) / (cue.end - cue.fadeOut);
}

export function computeHeroLayout(input: HeroLayoutInput): HeroLayout {
  const mode = input.mode ?? (input.width <= HERO_LAYOUT_CONTRACT.breakpoint ? "mobile" : "desktop");
  const boundaryY = input.stableHeight * HERO_LAYOUT_CONTRACT.boundaryRatio;
  const stageTop = input.stableHeight * (
    mode === "mobile"
      ? HERO_LAYOUT_CONTRACT.mobileStageTopRatio
      : HERO_LAYOUT_CONTRACT.desktopStageTopRatio
  );
  const copyTop = input.stableHeight * (
    mode === "mobile"
      ? HERO_LAYOUT_CONTRACT.mobileCopyTopRatio
      : HERO_LAYOUT_CONTRACT.desktopCopyTopRatio
  );
  const effectiveDpr = Math.min(Math.max(input.dpr, 1), HERO_LAYOUT_CONTRACT.maxCanvasDpr);
  const stage = rect(0, stageTop, input.width, boundaryY - stageTop);
  const boundary = rect(0, boundaryY, input.width, 0);
  const centeredCopy = { x: input.width / 2, y: copyTop };
  const copyAnchors = mode === "mobile"
    ? { role: centeredCopy, experience: centeredCopy }
    : {
        role: { x: input.width * 0.06, y: copyTop },
        experience: { x: input.width * 0.94, y: copyTop },
      };
  return {
    mode,
    firstScreen: rect(0, 0, input.width, input.stableHeight),
    copyAnchor: centeredCopy,
    copyAnchors,
    stage,
    canvas: stage,
    boundaryY,
    boundary,
    ctaAnchor: { x: input.width / 2, y: boundaryY },
    hintAnchor: { x: input.width / 2, y: boundaryY + HERO_LAYOUT_CONTRACT.hintOffset },
    aboutOverlap: Math.max(0, input.stableHeight - boundaryY),
    backingStore: {
      width: Math.round(stage.width * effectiveDpr),
      height: Math.round(stage.height * effectiveDpr),
      effectiveDpr,
    },
  };
}

/**
 * Existing mobile name retained as a thin projection of the shared contract.
 * The explicit mode prevents an unusually narrow desktop test fixture from
 * silently selecting a different layout policy.
 */
export function computeStableMobileHeroLayout(
  input: StableMobileHeroInput,
): StableMobileHeroLayout {
  return computeHeroLayout({ ...input, mode: "mobile" });
}

export function sampleMobileHeroCues(targetFrame: number): {
  roleOpacity: number;
  experienceOpacity: number;
} {
  return {
    roleOpacity: opacity(targetFrame, MOBILE_HERO_CONTRACT.role),
    experienceOpacity: opacity(targetFrame, MOBILE_HERO_CONTRACT.experience),
  };
}

function easeInOut(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/**
 * Pure elapsed-time timeline sampling.  A renderer may sample this at any
 * refresh rate and receives the same frame at the same wall-clock time.
 */
export function sampleHeroTimeline(
  phase: HeroPhase,
  elapsedMs: number,
): HeroTimelineSample {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Hero timeline elapsedMs must be finite and non-negative");
  }
  if (phase === "intro") {
    const progress = Math.min(1, elapsedMs / HERO_CONTRACT.introDurationMs);
    return {
      progress,
      targetFrame:
        HERO_CONTRACT.startFrame +
        easeInOut(progress) * (HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame),
    };
  }
  if (phase === "playing") {
    const progress = Math.min(1, elapsedMs / HERO_CONTRACT.playbackDurationMs);
    return {
      progress,
      targetFrame:
        HERO_CONTRACT.introEndFrame +
        easeInOut(progress) * (HERO_CONTRACT.endFrame - HERO_CONTRACT.introEndFrame),
    };
  }
  if (phase === "loading") {
    return { progress: 0, targetFrame: HERO_CONTRACT.startFrame };
  }
  if (phase === "ready") {
    return { progress: 0, targetFrame: HERO_CONTRACT.introEndFrame };
  }
  return { progress: 1, targetFrame: HERO_CONTRACT.endFrame };
}

/** Convenience projection for renderers that only need the requested frame. */
export function sampleHeroFrame(phase: HeroPhase, elapsedMs: number): number {
  return sampleHeroTimeline(phase, elapsedMs).targetFrame;
}

/**
 * Exponential frame smoothing with the former 0.07 coefficient as its
 * reference point at 60Hz.  Unlike a fixed per-render lerp, the same elapsed
 * duration produces the same amount of convergence at 30, 60, or 120Hz.
 */
export function smoothHeroFrame(
  currentFrame: number,
  targetFrame: number,
  elapsedMs: number,
): number {
  if (!Number.isFinite(currentFrame) || !Number.isFinite(targetFrame)) {
    throw new RangeError("Hero frame values must be finite");
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Hero frame elapsedMs must be finite and non-negative");
  }
  if (elapsedMs === 0 || currentFrame === targetFrame) return currentFrame;

  const referenceFrameMs = 1000 / 60;
  const referenceRetention = 1 - 0.07;
  const retention = Math.pow(referenceRetention, elapsedMs / referenceFrameMs);
  return currentFrame + (targetFrame - currentFrame) * (1 - retention);
}

/** Alias for callers that describe this operation as interpolation. */
export const interpolateHeroFrame = smoothHeroFrame;

/**
 * Compute the named CTA state.  `latched` is supplied by a stateful runtime so
 * availability cannot disappear if a pointer/input update moves the requested
 * frame backwards after the threshold has been crossed.
 */
export function sampleHeroCTA(input: {
  phase: HeroPhase;
  targetFrame: number;
  reducedMotion?: boolean;
  latched?: boolean;
}): HeroCTASample {
  if (!Number.isFinite(input.targetFrame)) {
    throw new RangeError("Hero CTA targetFrame must be finite");
  }
  const reduced = input.reducedMotion === true || input.phase === "reduced";
  const available =
    reduced ||
    input.latched === true ||
    input.phase === "complete" ||
    input.phase === "exit-hold" ||
    input.phase === "released" ||
    (input.phase === "playing" &&
      input.targetFrame >= MOBILE_HERO_CONTRACT.ctaAvailableTargetFrame);
  return {
    state: available ? "available" : "unavailable",
    available,
    opacity: available ? 1 : 0,
    pointerEvents: available ? "all" : "none",
  };
}

/**
 * Mobile's copy groups share one centered slot and replace each other in the
 * declared frame intervals.  CTA wins cue selection once its availability is
 * latched, making the three-step order explicit to diagnostics.
 */
export function sampleMobileHeroPresentation(input: {
  targetFrame: number;
  phase?: HeroPhase;
  reducedMotion?: boolean;
  ctaAvailable?: boolean;
  /** Set only after the playing timeline reaches its terminal frame. */
  playbackCompleted?: boolean;
}): HeroPresentationSample {
  const phase = input.phase ?? "playing";
  const reduced = input.reducedMotion === true || phase === "reduced";
  const terminal =
    input.playbackCompleted === true &&
    (phase === "complete" || phase === "exit-hold" || phase === "released");
  // Once playback has completed, the experience copy is the hero's durable
  // terminal label. Pointer drift and navigation may change the phase/frame,
  // but only an observed completed playback may make it durable.
  const cues = reduced
    ? { roleOpacity: 1, experienceOpacity: 1 }
    : terminal
      ? { roleOpacity: 0, experienceOpacity: 1 }
      : sampleMobileHeroCues(input.targetFrame);
  const cta = sampleHeroCTA({
    phase,
    targetFrame: input.targetFrame,
    reducedMotion: reduced,
    latched: input.ctaAvailable,
  });
  let cue: HeroCue | null = null;
  if (cta.available) cue = "cta";
  else if (cues.experienceOpacity >= cues.roleOpacity && cues.experienceOpacity > 0) cue = "experience";
  else if (cues.roleOpacity > 0) cue = "role";
  return { ...cues, cue, ctaAvailable: cta.available, cta };
}

/**
 * Pure hero phase reducer. Invalid/repeated events are idempotent and leave
 * the phase unchanged, which makes repeated input safe for browser handlers.
 */
export function transitionHeroPhase(
  phase: HeroPhase,
  event: HeroPhaseEvent,
): HeroPhase {
  if (event === "reduced-motion") return "reduced";
  if (event === "release") return phase === "reduced" ? "reduced" : "released";
  switch (phase) {
    case "loading":
      return event === "assets-ready" ? "intro" : phase;
    case "intro":
      return event === "intro-complete" ? "ready" : phase;
    case "ready":
      return event === "advance" ? "playing" : phase;
    case "playing":
      return event === "playback-complete" ? "complete" : phase;
    case "complete":
      return event === "request-exit" ? "exit-hold" : phase;
    case "exit-hold":
      if (event === "cancel-exit") return "complete";
      return event === "exit-delay-complete" ? "released" : phase;
    case "released":
    case "reduced":
      return phase;
  }
}

/** Naming alias for reducer-oriented callers. */
export const reduceHeroPhase = transitionHeroPhase;

/** Lower-camel-case alias matching the existing `sample*` naming style. */
export const sampleHeroCta = sampleHeroCTA;

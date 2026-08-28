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

/**
 * Union of the alpha>8 bounds measured across all 150 mobile source frames.
 * The coordinates are in the natural 900×507 image space. Keeping the
 * envelope beside the placement contract means a future art replacement must
 * update one auditable geometry record instead of silently re-centering from
 * whichever frame happened to be ready first.
 */
export const MOBILE_HERO_ASSET_ENVELOPE = Object.freeze({
  naturalWidth: 900,
  naturalHeight: 507,
  left: 166,
  right: 756,
});

export const MOBILE_HERO_CONTRACT = Object.freeze({
  boundaryRatio: 0.85,
  stageTopRatio: 0.38,
  copyTopRatio: 0.09,
  desktopCopyTopRatio: 0.38,
  hintOffset: 62,
  maxCanvasDpr: 2,
  // The mobile cutout is intentionally 40% larger than the former 0.55 fit
  // scale. The rendered alpha bounds, rather than this token alone, are the
  // browser acceptance seam for N2.
  assetScale: 0.77,
  // Center the union of every frame's alpha>8 horizontal bounds, not the
  // ready frame alone. (166 + 756) / (2 × 900) = 0.512222…
  assetVisualCenterRatio:
    (MOBILE_HERO_ASSET_ENVELOPE.left + MOBILE_HERO_ASSET_ENVELOPE.right) /
    (2 * MOBILE_HERO_ASSET_ENVELOPE.naturalWidth),
  // Mobile groups occupy one slot. The role reaches zero exactly when the
  // experience begins, so replacement never renders both groups at once.
  role: { fadeIn: 5, peak: 14, fadeOut: 48, end: 58 },
  // Once the experience cue reaches full opacity, keep it visible through
  // the terminal playback frame. Its fade-out starts after the timeline's
  // end, so completion cannot produce a copy gap before the terminal latch.
  experience: {
    fadeIn: 58,
    peak: 72,
    fadeOut: HERO_CONTRACT.endFrame,
    end: HERO_CONTRACT.endFrame + 1,
  },
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
  // A small, fixed CSS-pixel nudge keeps the mobile copy legible without
  // changing its relationship to the stable first-screen geometry when the
  // viewport has enough room for the complete experience group.
  mobileCopyOffsetPx: 24,
  // Measured upper bound of the mobile #st2 rendered copy at the 320px text
  // breakpoint (124.9px) plus roughly 3px of clearance. The requested nudge
  // is capped against stageTop - this reserve on short viewports, so the
  // larger experience group stays above the animation stage while retaining
  // as much of the requested downward shift as the viewport permits.
  mobileCopySafeHeightPx: 128,
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

export type MobileHeroAssetPlacementInput = {
  canvasWidth: number;
  canvasHeight: number;
  naturalWidth: number;
  naturalHeight: number;
};

export type MobileHeroAssetPlacement = {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Pure mobile image placement. The renderer and clipping tests use the same
 * destination math, while the full-frame alpha envelope remains an
 * independent acceptance fact rather than a canvas-size assumption.
 */
export function computeMobileHeroAssetPlacement(
  input: MobileHeroAssetPlacementInput,
): MobileHeroAssetPlacement {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Mobile hero asset ${name} must be finite and positive`);
    }
  }
  const scale =
    Math.max(input.canvasWidth / input.naturalWidth, input.canvasHeight / input.naturalHeight) *
    MOBILE_HERO_CONTRACT.assetScale;
  const width = input.naturalWidth * scale;
  const height = input.naturalHeight * scale;
  const x = width > input.canvasWidth
    ? input.canvasWidth / 2 - input.naturalWidth * scale * MOBILE_HERO_CONTRACT.assetVisualCenterRatio
    : (input.canvasWidth - width) / 2;
  return {
    scale,
    x,
    y: input.canvasHeight - height,
    width,
    height,
  };
}

/**
 * Mobile copy anchor with a bounded downward nudge. The cap is a layout
 * safety rule, not an animation state: it keeps both replacement groups in
 * the first-screen copy slot even at short 320×480 viewports.
 */
export function computeMobileHeroCopyTop(stableHeight: number): number {
  if (!Number.isFinite(stableHeight) || stableHeight <= 0) {
    throw new RangeError("Mobile hero stableHeight must be finite and positive");
  }
  const requestedTop =
    stableHeight * HERO_LAYOUT_CONTRACT.mobileCopyTopRatio + HERO_LAYOUT_CONTRACT.mobileCopyOffsetPx;
  const stageTop = stableHeight * HERO_LAYOUT_CONTRACT.mobileStageTopRatio;
  const safeTop = Math.max(0, stageTop - HERO_LAYOUT_CONTRACT.mobileCopySafeHeightPx);
  return Math.min(requestedTop, safeTop);
}

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
  const copyTop = mode === "mobile"
    ? computeMobileHeroCopyTop(input.stableHeight)
    : input.stableHeight * HERO_LAYOUT_CONTRACT.desktopCopyTopRatio;
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

/**
 * Pure elapsed-time timeline sampling.  A renderer may sample this at any
 * refresh rate and receives the same frame at the same wall-clock time. The
 * authored sequence is evenly timed, so the native media clock and C's frame
 * selection share a linear per-segment mapping.
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
        progress * (HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame),
    };
  }
  if (phase === "playing") {
    const progress = Math.min(1, elapsedMs / HERO_CONTRACT.playbackDurationMs);
    return {
      progress,
      targetFrame:
        HERO_CONTRACT.introEndFrame +
        progress * (HERO_CONTRACT.endFrame - HERO_CONTRACT.introEndFrame),
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
  const terminalPhase =
    phase === "complete" || phase === "exit-hold" || phase === "released";
  const terminal = input.playbackCompleted === true && terminalPhase;
  // Once playback has completed, the experience copy is the hero's durable
  // terminal label. Pointer drift and navigation may change the phase/frame,
  // but only an observed completed playback may make it durable.
  const cues = reduced
    ? { roleOpacity: 1, experienceOpacity: 1 }
    : terminalPhase
      ? terminal
        ? { roleOpacity: 0, experienceOpacity: 1 }
        : { roleOpacity: 0, experienceOpacity: 0 }
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
      // Intro completion starts the main segment immediately. `ready` remains
      // a valid explicit/manual phase for callers, but is never an automatic
      // dwell checkpoint where animation waits for a gesture.
      return event === "intro-complete" ? "playing" : phase;
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

/**
 * Returns whether a mobile downward gesture must stay inside the hero. The
 * lock covers loading/intro/ready and the first part of playback. Playback's
 * semantic handoff is the frame at which the experience copy begins replacing
 * UX/UI; terminal exit remains consumed because it is a scripted navigation
 * action rather than native scrolling.
 */
export function mobileHeroConsumesDownwardScroll(input: {
  phase: HeroPhase;
  targetFrame: number;
  reducedMotion?: boolean;
}): boolean {
  if (!Number.isFinite(input.targetFrame)) {
    throw new RangeError("Mobile hero scroll targetFrame must be finite");
  }
  if (input.reducedMotion === true || input.phase === "reduced") return false;
  if (input.phase === "loading" || input.phase === "intro" || input.phase === "ready") return true;
  if (input.phase === "playing") {
    return input.targetFrame < MOBILE_HERO_CONTRACT.experience.fadeIn;
  }
  return input.phase === "complete" || input.phase === "exit-hold";
}

export type MobileHeroDownwardScrollDisposition = "consume" | "native-next-gesture";

/**
 * Names the browser handoff explicitly. A dispatched touch event cannot be
 * retroactively released after preventDefault(); therefore the renderer's
 * first native opportunity is the next downward gesture once frame 58 has
 * been reached. This is deliberately not a same-touch-gesture claim.
 */
export function mobileHeroDownwardScrollDisposition(input: {
  phase: HeroPhase;
  targetFrame: number;
  reducedMotion?: boolean;
}): MobileHeroDownwardScrollDisposition {
  return mobileHeroConsumesDownwardScroll(input) ? "consume" : "native-next-gesture";
}

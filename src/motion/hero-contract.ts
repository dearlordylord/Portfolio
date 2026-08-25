import { rect, type Rect } from "./types";

export const MOBILE_HERO_CONTRACT = Object.freeze({
  boundaryRatio: 0.85,
  stageTopRatio: 0.38,
  maxCanvasDpr: 2,
  role: { fadeIn: 5, peak: 14, fadeOut: 48, end: 62 },
  experience: { fadeIn: 58, peak: 72, fadeOut: 128, end: 145 },
  ctaAvailableTargetFrame: 128,
});

export type StableMobileHeroInput = {
  width: number;
  visualHeight: number;
  stableHeight: number;
  dpr: number;
};

export type StableMobileHeroLayout = {
  firstScreen: Rect;
  copyAnchor: { x: number; y: number };
  stage: Rect;
  boundaryY: number;
  ctaAnchor: { x: number; y: number };
  backingStore: { width: number; height: number; effectiveDpr: number };
};

function opacity(frame: number, cue: typeof MOBILE_HERO_CONTRACT.role): number {
  if (frame < cue.fadeIn || frame > cue.end) return 0;
  if (frame < cue.peak) return (frame - cue.fadeIn) / (cue.peak - cue.fadeIn);
  if (frame < cue.fadeOut) return 1;
  return 1 - (frame - cue.fadeOut) / (cue.end - cue.fadeOut);
}

export function computeStableMobileHeroLayout(
  input: StableMobileHeroInput,
): StableMobileHeroLayout {
  const boundaryY = input.stableHeight * MOBILE_HERO_CONTRACT.boundaryRatio;
  const stageTop = input.stableHeight * MOBILE_HERO_CONTRACT.stageTopRatio;
  const effectiveDpr = Math.min(Math.max(input.dpr, 1), MOBILE_HERO_CONTRACT.maxCanvasDpr);
  const stage = rect(0, stageTop, input.width, boundaryY - stageTop);
  return {
    firstScreen: rect(0, 0, input.width, input.stableHeight),
    copyAnchor: { x: input.width / 2, y: input.stableHeight * 0.09 },
    stage,
    boundaryY,
    ctaAnchor: { x: input.width / 2, y: boundaryY },
    backingStore: {
      width: Math.round(stage.width * effectiveDpr),
      height: Math.round(stage.height * effectiveDpr),
      effectiveDpr,
    },
  };
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

/**
 * Production hero renderer policy.
 *
 * This module is intentionally browser-independent. It names the only
 * renderers that may exist on the real page and keeps selection/fallback
 * decisions testable without constructing media elements. The packed H.264
 * renderer from the architecture prototype is deliberately absent here.
 * HEVC browser/asset qualification lives in `hevc-alpha.ts`; this module
 * re-exports that pure gate for the browser adapter's single import surface.
 */

import {
  HEVC_ALPHA_MIME,
  HEVC_ALPHA_PRODUCTION_ASSET,
  HEVC_ALPHA_PRODUCTION_EVIDENCE,
  HEVC_ALPHA_MIN_IOS_MAJOR,
  HEVC_PREPARATION_DEADLINE_MS,
  evaluateProductionHevcQualification,
  isAppleSafariProfile,
  isProductionHevcAlphaQualified,
  isQualifiedAppleSafariProfile,
  parseIPhoneOSMajor,
} from "./hevc-alpha";

export const HERO_NATIVE_FRAME_RATE = 15;
export const HERO_NATIVE_FRAME_COUNT = 150;
export const HERO_NATIVE_INTRO_END_FRAME = 31;
export const HERO_NATIVE_END_FRAME = HERO_NATIVE_FRAME_COUNT - 1;
export const HERO_NATIVE_INTRO_DURATION_MS = 1_400;
export const HERO_NATIVE_PLAYBACK_DURATION_MS = 3_500;
/** A bounded native preparation window before the page fails open to C. */
export const HERO_NATIVE_PREPARATION_DEADLINE_MS = HEVC_PREPARATION_DEADLINE_MS;

/**
 * The source sequence is the layout authority for the cutout. Native media
 * is fitted to this content rectangle even when its coded dimensions differ
 * (the checked-in H asset is a higher-resolution 16:9 encode).
 */
export const HERO_NATIVE_CONTENT_WIDTH = 900;
export const HERO_NATIVE_CONTENT_HEIGHT = 507;

export const HERO_HEVC_ALPHA_MIME = HEVC_ALPHA_MIME;
export const HERO_VP9_ALPHA_MIME = 'video/webm; codecs="vp09.00.10.08"';

export {
  HEVC_ALPHA_PRODUCTION_ASSET,
  HEVC_ALPHA_PRODUCTION_EVIDENCE,
  HEVC_ALPHA_MIN_IOS_MAJOR,
  evaluateProductionHevcQualification,
  isAppleSafariProfile,
  isProductionHevcAlphaQualified,
  parseIPhoneOSMajor,
  isQualifiedAppleSafariProfile,
};

export type ProductionHeroRenderer = "h" | "a" | "c";
export type ProductionHeroRendererPreference = "auto" | ProductionHeroRenderer;

export type HeroRendererSelectionInput = Readonly<{
  preference?: ProductionHeroRendererPreference;
  hevcCanPlayType?: string | null;
  vp9CanPlayType?: string | null;
  /** Result of the full checked-in-asset + iPhone-Safari evidence gate. */
  hevcEnvironmentQualified?: boolean;
  /** Broad Apple Safari detection; unqualified Safari must fall to C. */
  safariProfileDetected?: boolean;
}>;

/**
 * Select the production ladder. A decoder claim is only a candidate gate;
 * the browser adapter still has to qualify A's decoded alpha or H's media
 * readiness before exposing a native surface.
 */
export function selectProductionHeroRenderer(
  input: HeroRendererSelectionInput = {},
): ProductionHeroRenderer {
  const preference = input.preference ?? "auto";
  if (preference === "c") return "c";
  if (preference === "h") return input.hevcCanPlayType ? "h" : "c";
  if (preference === "a") return input.vp9CanPlayType ? "a" : "c";
  if (input.hevcEnvironmentQualified && input.hevcCanPlayType) return "h";
  if (input.safariProfileDetected) return "c";
  if (input.vp9CanPlayType) return "a";
  return "c";
}

/** Every native candidate failure has one correctness-preserving destination. */
export function fallbackProductionHeroRenderer(
  renderer: ProductionHeroRenderer,
): "c" | null {
  return renderer === "c" ? null : "c";
}

/** A native surface is never exposed before its media/readback gate passes. */
export function nativeCandidateCanExpose(
  renderer: "h" | "a",
  input: Readonly<{
    loadedData: boolean;
    canPlay: boolean;
    alphaProof: boolean;
    /** A real rVFC callback has observed a frame reaching the presentation path. */
    presentationProof: boolean;
  }>,
): boolean {
  return input.loadedData
    && input.canPlay
    && input.presentationProof
    && (renderer === "h" || input.alphaProof);
}

export function nativeFrameToSeconds(frame: number): number {
  if (!Number.isFinite(frame) || frame < 0) throw new RangeError("Hero native frame must be finite and non-negative");
  return frame / HERO_NATIVE_FRAME_RATE;
}

export function nativeFrameFromSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("Hero native time must be finite and non-negative");
  return Math.max(0, Math.min(HERO_NATIVE_END_FRAME, Math.round(seconds * HERO_NATIVE_FRAME_RATE)));
}

export function nativeIntroPlaybackRate(): number {
  return nativeFrameToSeconds(HERO_NATIVE_INTRO_END_FRAME) / (HERO_NATIVE_INTRO_DURATION_MS / 1_000);
}

export function nativeMainPlaybackRate(): number {
  return (
    (HERO_NATIVE_END_FRAME - HERO_NATIVE_INTRO_END_FRAME) / HERO_NATIVE_FRAME_RATE
  ) / (HERO_NATIVE_PLAYBACK_DURATION_MS / 1_000);
}

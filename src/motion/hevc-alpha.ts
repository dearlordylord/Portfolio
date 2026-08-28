/**
 * PROTOTYPE ONLY — Safari HEVC-with-alpha selection and release gate.
 *
 * Native alpha video is only safe here as a direct DOM layer. A browser
 * decoder claim is not enough: the candidate must have an imported Apple
 * auxiliary-alpha asset, a seekable delivery (or an explicit Blob), and
 * external device alpha evidence tied to that asset/version. A
 * canvas/WebGL readback is not valid evidence for Safari's direct-DOM path.
 */

import type { MediaDeliverySnapshot } from "./media-delivery";

export const HEVC_ALPHA_MIME = 'video/quicktime; codecs="hvc1.1.6.L93.B0"';

/**
 * Maximum time the prototype gives a qualified HEVC candidate to download a
 * Blob and produce its first usable media frame. The budget is intentionally
 * finite: the prototype's measured first random video seek was about 1.1 s,
 * while the existing playback observation budget is 2 s; 4 s leaves room for
 * the full Blob preparation without allowing a blank hero to persist.
 */
export const HEVC_PREPARATION_DEADLINE_MS = 4_000;

export const HEVC_RELEASE_CHECKS = [
  "macos-alpha-and-edges",
  "ios-alpha-and-edges",
  "autoplay-and-resume",
  "scrub-targets",
  "reduced-motion",
  "seekable-delivery",
  "opaque-fallback",
] as const;

export type HevcReleaseCheck = (typeof HEVC_RELEASE_CHECKS)[number];
export type HevcQualification = "unqualified" | "qualified" | "failed";
export type HevcGateStatus = "pending" | "accepted" | "fallback";

export type HevcPreparationDeadlineDecision = Readonly<{
  status: "pending" | "timed-out";
  elapsedMs: number;
  deadlineMs: number;
}>;

export type HevcGateInput = Readonly<{
  sourceUrl?: string | null;
  assetId?: string | null;
  assetPresent: boolean;
  canPlayType: string;
  directDom: boolean;
  qualification: HevcQualification;
  qualificationEvidence?: string | null;
  delivery: MediaDeliverySnapshot;
  mediaCapabilitiesAlpha?: boolean | null;
  forcedFailure?: boolean;
}>;

export type HevcGateDecision = Readonly<{
  status: HevcGateStatus;
  reason: string;
  expose: boolean;
  directDom: boolean;
  qualification: HevcQualification;
  delivery: MediaDeliverySnapshot;
}>;

export type HevcReleaseEvidence = Partial<Readonly<Record<HevcReleaseCheck, boolean>>>;

export type HevcReleaseGate = Readonly<{
  status: "pending" | "passed" | "failed";
  missing: readonly HevcReleaseCheck[];
  failed: readonly HevcReleaseCheck[];
}>;

function hasSource(sourceUrl: string | null | undefined): boolean {
  return typeof sourceUrl === "string" && sourceUrl.trim() !== "";
}

function hasAssetBoundEvidence(input: HevcGateInput): boolean {
  const evidence = input.qualificationEvidence?.trim();
  const assetId = input.assetId?.trim();
  if (!evidence || !assetId) return false;
  const tokens = evidence.split("|").map((token) => token.trim());
  return tokens.includes(`asset:${assetId}`)
    && tokens.some((token) => token.startsWith("device:") && token.length > "device:".length);
}

/** Pure timeout seam for the browser adapter and deterministic tests. */
export function evaluateHevcPreparationDeadline(
  elapsedMs: number,
  deadlineMs = HEVC_PREPARATION_DEADLINE_MS,
): HevcPreparationDeadlineDecision {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("elapsedMs must be non-negative");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError("deadlineMs must be positive");
  return {
    status: elapsedMs >= deadlineMs ? "timed-out" : "pending",
    elapsedMs,
    deadlineMs,
  };
}

/**
 * Decide whether the hidden HEVC candidate may be made visible. `expose` is
 * false for every unqualified/fallback state, which is the opaque-flash guard.
 * Alpha qualification is deliberately external: a canvas/WebGL readback is
 * not valid evidence for Safari's direct-DOM HEVC path (WebKit bug 273006).
 */
export function evaluateHevcAlphaGate(input: HevcGateInput): HevcGateDecision {
  const fallback = (reason: string): HevcGateDecision => ({
    status: "fallback",
    reason,
    expose: false,
    directDom: input.directDom,
    qualification: input.qualification,
    delivery: input.delivery,
  });
  const pending = (reason: string): HevcGateDecision => ({
    status: "pending",
    reason,
    expose: false,
    directDom: input.directDom,
    qualification: input.qualification,
    delivery: input.delivery,
  });

  if (input.forcedFailure) return fallback("forced-failure");
  if (!input.assetPresent || !hasSource(input.sourceUrl)) return fallback("asset-missing-import-apple-hevc-alpha");
  if (!input.canPlayType) return fallback("codec-unsupported");
  if (!input.directDom) return fallback("direct-dom-required");
  if (input.mediaCapabilitiesAlpha === false) return fallback("media-capabilities-alpha-rejected");
  // Qualification is checked before delivery so an unqualified candidate
  // cannot even trigger a hidden media request. The evidence token is
  // intentionally asset/device-bound rather than a generic feature flag.
  if (input.qualification === "failed") return fallback("device-qualification-failed");
  if (
    input.qualification !== "qualified"
    || !hasAssetBoundEvidence(input)
  ) {
    return fallback("device-qualification-required");
  }
  if (input.delivery.mode === "failed") return fallback(`delivery-failed:${input.delivery.reason}`);
  if (!input.delivery.seekable) {
    if (input.delivery.mode === "pending") return pending("delivery-pending");
    return fallback("delivery-not-seekable");
  }
  return {
    status: "accepted",
    reason: "capability-evidence-bound-delivery-passed",
    expose: true,
    directDom: true,
    qualification: "qualified",
    delivery: input.delivery,
  };
}

/** A release decision remains blocked until every real-device check is true. */
export function evaluateHevcReleaseGate(evidence: HevcReleaseEvidence = {}): HevcReleaseGate {
  const missing = HEVC_RELEASE_CHECKS.filter((check) => evidence[check] !== true);
  const failed = HEVC_RELEASE_CHECKS.filter((check) => evidence[check] === false);
  return {
    status: failed.length > 0 ? "failed" : missing.length === 0 ? "passed" : "pending",
    missing,
    failed,
  };
}

export function formatHevcReleaseGate(evidence: HevcReleaseEvidence = {}): string {
  const gate = evaluateHevcReleaseGate(evidence);
  if (gate.status === "passed") return "passed · all real-device checks recorded";
  if (gate.status === "failed") return `failed · ${gate.failed.length} check(s)`;
  return `manual gate · ${gate.missing.length} check(s) pending`;
}

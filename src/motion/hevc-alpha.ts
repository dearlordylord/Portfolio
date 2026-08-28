/**
 * Safari HEVC-with-alpha policy and release gate.
 *
 * Native alpha video is only safe here as a direct DOM layer. A browser
 * decoder claim is not enough: the candidate must use the checked-in Apple
 * auxiliary-alpha asset and the exact real-device evidence recorded for that
 * asset. A canvas/WebGL readback is not valid evidence for Safari's
 * direct-DOM path.
 *
 * The old architecture page still imports the generic gate below for draft
 * failure-injection scenarios. Production selection uses the stricter
 * `evaluateProductionHevcQualification` gate.
 */

import type { MediaDeliverySnapshot } from "./media-delivery";

export const HEVC_ALPHA_MIME = 'video/quicktime; codecs="hvc1.1.6.L93.B0"';

/** Immutable runtime identity of the AVFoundation-validated HQ MOV. */
export const HEVC_ALPHA_PRODUCTION_ASSET = Object.freeze({
  assetId: "hero-hevc-alpha-hq-v1",
  sourceUrl: "/video-prototype/hero-hevc-alpha-hq.mov",
  sha256: "54ef6d6139d8690f0ea5bd8ab7c5dcfebe3176c6f462af7dc9b093fc3cb1a14c",
});

export type HevcProductionEvidence = Readonly<{
  assetId: string;
  sha256: string;
  device: "iphone-safari";
  confirmedByUser: boolean;
}>;

/**
 * Evidence is deliberately explicit and reviewable. It records the user's
 * real iPhone Safari confirmation for this exact asset; a support string or
 * a different asset cannot satisfy the production gate.
 */
export const HEVC_ALPHA_PRODUCTION_EVIDENCE: HevcProductionEvidence = Object.freeze({
  assetId: HEVC_ALPHA_PRODUCTION_ASSET.assetId,
  sha256: HEVC_ALPHA_PRODUCTION_ASSET.sha256,
  device: "iphone-safari",
  confirmedByUser: true,
});

/**
 * Maximum time a qualified HEVC candidate may prepare its first usable media
 * frame before the page fails open to C. Cloudflare Pages currently answers
 * the staged MOV without verified byte ranges, so the runtime prepares the
 * 11.2 MB file as a Blob behind frame 0. Four seconds bounds input lock and
 * blank-hero risk; range delivery is intentionally deferred as a separate
 * delivery improvement rather than hiding the cost in a longer timeout.
 */
export const HEVC_PREPARATION_DEADLINE_MS = 4_000;

/**
 * Lowest iOS major represented by the user-confirmed H evidence. This is an
 * evidence boundary for the production branch, not a claim that older iOS
 * releases cannot decode HEVC alpha.
 */
export const HEVC_ALPHA_MIN_IOS_MAJOR = 17;

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

export type HevcProductionQualificationInput = Readonly<{
  vendor?: string | null;
  userAgent?: string | null;
  canPlayType?: string | null;
  sourceUrl?: string | null;
  assetId?: string | null;
  assetSha256?: string | null;
  /** Defaults to the checked-in, user-confirmed evidence above. */
  evidence?: Partial<typeof HEVC_ALPHA_PRODUCTION_EVIDENCE> | null;
}>;

export type HevcProductionQualification = Readonly<{
  qualified: boolean;
  reason:
    | "qualified"
    | "safari-profile-required"
    | "iphone-safari-evidence-floor"
    | "ios-version-evidence-floor"
    | "codec-unsupported"
    | "asset-identity-mismatch"
    | "asset-evidence-mismatch";
}>;

/**
 * Exact browser floor for the checked-in H path. This intentionally accepts
 * Safari's native iPhone profile only: Chromium-on-iOS and other WebKit
 * shells do not inherit Safari alpha evidence merely because they advertise
 * a compatible codec string.
 */
export function isQualifiedAppleSafariProfile(input: Readonly<{
  vendor?: string | null;
  userAgent?: string | null;
}>): boolean {
  const vendor = input.vendor ?? "";
  const userAgent = input.userAgent ?? "";
  return isAppleSafariProfile({ vendor, userAgent })
    && /iPhone/i.test(userAgent)
    && (parseIPhoneOSMajor(userAgent) ?? 0) >= HEVC_ALPHA_MIN_IOS_MAJOR;
}

/** Parse only the native iPhone UA token; missing/ambiguous versions fail closed. */
export function parseIPhoneOSMajor(userAgent: string | null | undefined): number | null {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/\biPhone OS (\d+)(?:[_\s.;)]|$)/i);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 0 ? major : null;
}

/** Broad Safari detection used to prevent an unqualified Safari from taking A. */
export function isAppleSafariProfile(input: Readonly<{
  vendor?: string | null;
  userAgent?: string | null;
}>): boolean {
  const vendor = input.vendor ?? "";
  const userAgent = input.userAgent ?? "";
  return vendor === "Apple Computer, Inc."
    && /Safari/i.test(userAgent)
    && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|Android)/i.test(userAgent);
}

/**
 * Production H gate. It is pure so unsupported/unqualified environments can
 * be tested without media elements; the browser adapter only calls it before
 * requesting or exposing the MOV.
 */
export function evaluateProductionHevcQualification(
  input: HevcProductionQualificationInput = {},
): HevcProductionQualification {
  const evidence = input.evidence ?? HEVC_ALPHA_PRODUCTION_EVIDENCE;
  if (!isAppleSafariProfile(input)) {
    return { qualified: false, reason: "safari-profile-required" };
  }
  if (!isQualifiedAppleSafariProfile(input)) {
    return {
      qualified: false,
      reason: /iPhone/i.test(input.userAgent ?? "")
        ? "ios-version-evidence-floor"
        : "iphone-safari-evidence-floor",
    };
  }
  if (!input.canPlayType) {
    return { qualified: false, reason: "codec-unsupported" };
  }
  if (
    input.sourceUrl !== HEVC_ALPHA_PRODUCTION_ASSET.sourceUrl
    || input.assetId !== HEVC_ALPHA_PRODUCTION_ASSET.assetId
    || input.assetSha256 !== HEVC_ALPHA_PRODUCTION_ASSET.sha256
  ) {
    return { qualified: false, reason: "asset-identity-mismatch" };
  }
  if (
    evidence.assetId !== HEVC_ALPHA_PRODUCTION_EVIDENCE.assetId
    || evidence.sha256 !== HEVC_ALPHA_PRODUCTION_EVIDENCE.sha256
    || evidence.device !== HEVC_ALPHA_PRODUCTION_EVIDENCE.device
    || evidence.confirmedByUser !== true
  ) {
    return { qualified: false, reason: "asset-evidence-mismatch" };
  }
  return { qualified: true, reason: "qualified" };
}

export function isProductionHevcAlphaQualified(
  input: HevcProductionQualificationInput = {},
): boolean {
  return evaluateProductionHevcQualification(input).qualified;
}

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

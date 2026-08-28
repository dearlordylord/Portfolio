import { describe, expect, it } from "vitest";

import {
  fallbackProductionHeroRenderer,
  HERO_NATIVE_END_FRAME,
  HERO_NATIVE_INTRO_END_FRAME,
  HERO_NATIVE_PREPARATION_DEADLINE_MS,
  HEVC_ALPHA_PRODUCTION_EVIDENCE,
  HEVC_ALPHA_PRODUCTION_ASSET,
  HEVC_ALPHA_MIN_IOS_MAJOR,
  evaluateProductionHevcQualification,
  isAppleSafariProfile,
  isQualifiedAppleSafariProfile,
  parseIPhoneOSMajor,
  nativeCandidateCanExpose,
  nativeFrameFromSeconds,
  nativeFrameToSeconds,
  nativeIntroPlaybackRate,
  nativeMainPlaybackRate,
  selectProductionHeroRenderer,
} from "../../src/motion/hero-renderer";

describe("production hero renderer policy", () => {
  it("selects HEVC, then VP9, then the WebP correctness renderer", () => {
    expect(selectProductionHeroRenderer({ hevcCanPlayType: "probably", vp9CanPlayType: "probably", hevcEnvironmentQualified: true })).toBe("h");
    expect(selectProductionHeroRenderer({ hevcCanPlayType: "probably", vp9CanPlayType: "probably", hevcEnvironmentQualified: false })).toBe("a");
    expect(selectProductionHeroRenderer({
      hevcCanPlayType: "probably",
      vp9CanPlayType: "probably",
      hevcEnvironmentQualified: false,
      safariProfileDetected: true,
    })).toBe("c");
    expect(selectProductionHeroRenderer({ hevcCanPlayType: "", vp9CanPlayType: "probably" })).toBe("a");
    expect(selectProductionHeroRenderer({ hevcCanPlayType: "", vp9CanPlayType: "" })).toBe("c");
  });

  it("qualifies only the Apple Safari profile used by the device evidence", () => {
    expect(isQualifiedAppleSafariProfile({
      vendor: "Apple Computer, Inc.",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    })).toBe(true);
    expect(isQualifiedAppleSafariProfile({
      vendor: "Google Inc.",
      userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    })).toBe(false);
    expect(isQualifiedAppleSafariProfile({
      vendor: "Apple Computer, Inc.",
      userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1",
    })).toBe(false);
    expect(isAppleSafariProfile({
      vendor: "Apple Computer, Inc.",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    })).toBe(true);
    expect(isQualifiedAppleSafariProfile({
      vendor: "Apple Computer, Inc.",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    })).toBe(false);
  });

  it("requires the checked-in HQ asset and user-confirmed iPhone Safari evidence", () => {
    const iphoneSafari = {
      vendor: "Apple Computer, Inc.",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      canPlayType: "probably",
      sourceUrl: HEVC_ALPHA_PRODUCTION_ASSET.sourceUrl,
      assetId: HEVC_ALPHA_PRODUCTION_ASSET.assetId,
      assetSha256: HEVC_ALPHA_PRODUCTION_ASSET.sha256,
    };
    expect(evaluateProductionHevcQualification(iphoneSafari)).toEqual({ qualified: true, reason: "qualified" });
    expect(evaluateProductionHevcQualification({ ...iphoneSafari, canPlayType: "" })).toMatchObject({
      qualified: false,
      reason: "codec-unsupported",
    });
    expect(evaluateProductionHevcQualification({
      ...iphoneSafari,
      userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1",
    })).toMatchObject({ qualified: false, reason: "safari-profile-required" });
    expect(evaluateProductionHevcQualification({
      ...iphoneSafari,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    })).toMatchObject({ qualified: false, reason: "iphone-safari-evidence-floor" });
    expect(HEVC_ALPHA_MIN_IOS_MAJOR).toBe(17);
    expect(parseIPhoneOSMajor(iphoneSafari.userAgent)).toBe(18);
    expect(parseIPhoneOSMajor("Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1")).toBe(16);
    expect(parseIPhoneOSMajor("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1")).toBeNull();
    const oldOrUnknownSafari = [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    ];
    for (const userAgent of oldOrUnknownSafari) {
      const qualification = evaluateProductionHevcQualification({ ...iphoneSafari, userAgent });
      expect(qualification).toMatchObject({ qualified: false, reason: "ios-version-evidence-floor" });
      expect(selectProductionHeroRenderer({
        hevcCanPlayType: "probably",
        vp9CanPlayType: "probably",
        hevcEnvironmentQualified: qualification.qualified,
        safariProfileDetected: isAppleSafariProfile({ vendor: iphoneSafari.vendor, userAgent }),
      })).toBe("c");
    }
    expect(evaluateProductionHevcQualification({
      ...iphoneSafari,
      assetSha256: "0".repeat(64),
    })).toMatchObject({ qualified: false, reason: "asset-identity-mismatch" });
    expect(evaluateProductionHevcQualification({
      ...iphoneSafari,
      evidence: { ...HEVC_ALPHA_PRODUCTION_EVIDENCE, confirmedByUser: false },
    })).toMatchObject({ qualified: false, reason: "asset-evidence-mismatch" });
  });

  it("routes every native failure directly to C and has no packed renderer", () => {
    expect(fallbackProductionHeroRenderer("h")).toBe("c");
    expect(fallbackProductionHeroRenderer("a")).toBe("c");
    expect(fallbackProductionHeroRenderer("c")).toBeNull();
  });

  it("keeps native preparation bounded before the C fallback can take over", () => {
    expect(HERO_NATIVE_PREPARATION_DEADLINE_MS).toBe(4_000);
    expect(HERO_NATIVE_PREPARATION_DEADLINE_MS).toBeLessThan(5_000);
  });

  it("never exposes VP9 before decoded alpha proof", () => {
    expect(nativeCandidateCanExpose("a", { loadedData: true, canPlay: true, alphaProof: false })).toBe(false);
    expect(nativeCandidateCanExpose("a", { loadedData: true, canPlay: true, alphaProof: true })).toBe(true);
    expect(nativeCandidateCanExpose("h", { loadedData: true, canPlay: true, alphaProof: false })).toBe(true);
  });

  it("maps the existing hero phase durations to frames 31 and 149", () => {
    const introSeconds = 1.4 * nativeIntroPlaybackRate();
    const mainSeconds = 3.5 * nativeMainPlaybackRate();
    expect(nativeFrameFromSeconds(introSeconds)).toBe(HERO_NATIVE_INTRO_END_FRAME);
    expect(nativeFrameFromSeconds(nativeFrameToSeconds(HERO_NATIVE_INTRO_END_FRAME) + mainSeconds)).toBe(HERO_NATIVE_END_FRAME);
  });
});

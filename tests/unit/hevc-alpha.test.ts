import { describe, expect, it } from "vitest";

import {
  evaluateHevcAlphaGate,
  evaluateHevcPreparationDeadline,
  evaluateHevcReleaseGate,
  formatHevcReleaseGate,
  HEVC_ALPHA_MIME,
  HEVC_PREPARATION_DEADLINE_MS,
  HEVC_RELEASE_CHECKS,
  type HevcGateInput,
} from "../../src/motion/hevc-alpha";
import { mediaDeliveryFromBlob, pendingMediaDelivery } from "../../src/motion/media-delivery";

function candidate(overrides: Partial<HevcGateInput> = {}): HevcGateInput {
  return {
    sourceUrl: "/video-prototype/hero-hevc-alpha.mp4",
    assetId: "hero-hevc-alpha-v1",
    assetPresent: true,
    canPlayType: "probably",
    directDom: true,
    qualification: "qualified",
    qualificationEvidence: "asset:hero-hevc-alpha-v1|device:macos-safari",
    delivery: mediaDeliveryFromBlob(1024),
    ...overrides,
  };
}

describe("HEVC-with-alpha candidate gate", () => {
  it("uses the documented MIME and accepts only an evidence-qualified candidate", () => {
    expect(HEVC_ALPHA_MIME).toContain("hvc1");
    expect(evaluateHevcAlphaGate(candidate())).toMatchObject({
      status: "accepted",
      expose: true,
      reason: "capability-evidence-bound-delivery-passed",
    });
  });

  it("falls back before exposure when the imported Apple asset is absent", () => {
    expect(evaluateHevcAlphaGate(candidate({ assetPresent: false, sourceUrl: null }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "asset-missing-import-apple-hevc-alpha",
    });
  });

  it("rejects a candidate without explicit device-bound alpha evidence", () => {
    expect(evaluateHevcAlphaGate(candidate({ canPlayType: "" }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "codec-unsupported",
    });
    expect(evaluateHevcAlphaGate(candidate({ qualification: "unqualified", qualificationEvidence: null }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "device-qualification-required",
    });
    expect(evaluateHevcAlphaGate(candidate({ qualificationEvidence: "asset:other-v1|device:macos-safari" }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "device-qualification-required",
    });
    expect(evaluateHevcAlphaGate(candidate({ qualificationEvidence: "asset:hero-hevc-alpha-v1-preview|device:macos-safari" }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "device-qualification-required",
    });
    expect(evaluateHevcAlphaGate(candidate({ qualificationEvidence: "asset:hero-hevc-alpha-v1|device:" }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "device-qualification-required",
    });
    expect(evaluateHevcAlphaGate(candidate({ delivery: pendingMediaDelivery() }))).toMatchObject({
      status: "pending",
      expose: false,
      reason: "delivery-pending",
    });
  });

  it("rejects non-DOM composition, failed qualification, and non-seekable delivery", () => {
    expect(evaluateHevcAlphaGate(candidate({ directDom: false }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "direct-dom-required",
    });
    expect(evaluateHevcAlphaGate(candidate({ qualification: "failed", qualificationEvidence: "device-rejected" }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "device-qualification-failed",
    });
    expect(evaluateHevcAlphaGate(candidate({ delivery: { ...mediaDeliveryFromBlob(1024), mode: "url", seekable: false } }))).toMatchObject({
      status: "fallback",
      expose: false,
      reason: "delivery-not-seekable",
    });
  });
});

describe("HEVC preparation deadline", () => {
  it("keeps preparation pending before the documented deadline", () => {
    expect(evaluateHevcPreparationDeadline(HEVC_PREPARATION_DEADLINE_MS - 1)).toEqual({
      status: "pending",
      elapsedMs: HEVC_PREPARATION_DEADLINE_MS - 1,
      deadlineMs: HEVC_PREPARATION_DEADLINE_MS,
    });
  });

  it("times out at and after the deadline", () => {
    expect(evaluateHevcPreparationDeadline(HEVC_PREPARATION_DEADLINE_MS)).toEqual({
      status: "timed-out",
      elapsedMs: HEVC_PREPARATION_DEADLINE_MS,
      deadlineMs: HEVC_PREPARATION_DEADLINE_MS,
    });
  });
});

describe("HEVC real-device release gate", () => {
  it("never treats an unrecorded device matrix as a pass", () => {
    const gate = evaluateHevcReleaseGate();
    expect(gate.status).toBe("pending");
    expect(gate.missing).toEqual(HEVC_RELEASE_CHECKS);
    expect(formatHevcReleaseGate()).toContain("manual gate");
  });

  it("reports failed evidence distinctly from pending evidence", () => {
    const evidence = Object.fromEntries(HEVC_RELEASE_CHECKS.map((check) => [check, true]));
    evidence["ios-alpha-and-edges"] = false;
    expect(evaluateHevcReleaseGate(evidence)).toMatchObject({
      status: "failed",
      failed: ["ios-alpha-and-edges"],
      missing: ["ios-alpha-and-edges"],
    });
  });

  it("passes only when every required real-device check is true", () => {
    const evidence = Object.fromEntries(HEVC_RELEASE_CHECKS.map((check) => [check, true]));
    expect(evaluateHevcReleaseGate(evidence)).toEqual({ status: "passed", missing: [], failed: [] });
    expect(formatHevcReleaseGate(evidence)).toContain("passed");
  });
});

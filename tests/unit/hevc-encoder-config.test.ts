import { describe, expect, it } from "vitest";

import {
  HEVC_ENCODER_DEFAULTS,
  expectedHevcDurationSeconds,
  frameFileName,
  validateHevcEncoderConfig,
  validateHevcEncoderManifest,
} from "../../src/motion/hevc-encoder-config";

const validManifest = {
  schemaVersion: 1,
  assetId: "hero-hevc-alpha-v1",
  source: {
    inputPattern: HEVC_ENCODER_DEFAULTS.inputPattern,
    sourceSetSha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    width: 900,
    height: 507,
    frameCount: 150,
    frameRate: 15,
    durationSeconds: 10,
  },
  encode: {
    codec: "hevcWithAlpha",
    container: "mov",
    alphaMode: "premultiplied",
    alphaQuality: 1,
    maxKeyframeInterval: 15,
    averageBitRate: 8_000_000,
    codedWidth: 900,
    codedHeight: 508,
    contentRect: { x: 0, y: 0, width: 900, height: 507 },
    paddingRowCount: 1,
    paddingRowEdge: "bottom",
    paddingAlpha: "transparent",
    cleanAperture: "none",
  },
  output: {
    fileName: "hero-hevc-alpha.mov",
    bytes: 123_456,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    width: 900,
    height: 508,
    codedWidth: 900,
    codedHeight: 508,
    contentRect: { x: 0, y: 0, width: 900, height: 507 },
    paddingRowCount: 1,
    paddingRowEdge: "bottom",
    paddingAlpha: "transparent",
    cleanAperture: "none",
    frameCount: 150,
    frameRate: 15,
    durationSeconds: 10,
    codec: "hvc1",
    containsAlphaChannel: true,
    decodedAlphaMinimum: 0,
    decodedAlphaMaximum: 255,
    decodedContentAlphaMinimum: 0,
    decodedContentAlphaMaximum: 255,
    decodedPaddingAlphaMinimum: 0,
    decodedPaddingAlphaMaximum: 0,
  },
} as const;

describe("HEVC-alpha encoder configuration", () => {
  it("defines the supplied frame archive contract", () => {
    expect(HEVC_ENCODER_DEFAULTS).toMatchObject({
      sourceWidth: 900,
      sourceHeight: 507,
      codedWidth: 900,
      codedHeight: 508,
      paddingRowCount: 1,
      paddingRowEdge: "bottom",
      paddingAlpha: "transparent",
      cleanAperture: "none",
      frameCount: 150,
      frameRate: 15,
      keyframeInterval: 15,
      alphaQuality: 1,
      codec: "hevcWithAlpha",
      averageBitRate: 8_000_000,
      container: "mov",
    });
    expect(frameFileName(0)).toBe("frame_000_delay-0.067s.webp");
    expect(frameFileName(149)).toBe("frame_149_delay-0.067s.webp");
    expect(expectedHevcDurationSeconds()).toBe(10);
  });

  it("accepts the safe default and rejects unsafe encode settings", () => {
    expect(validateHevcEncoderConfig()).toEqual({ valid: true, errors: [] });
    expect(validateHevcEncoderConfig({ alphaQuality: -0.01 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ alphaQuality: 1.01 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ keyframeInterval: 0 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ keyframeInterval: 151 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ sourceWidth: 899 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ codedHeight: 506 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ frameRate: 0 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ averageBitRate: 0 })).toMatchObject({ valid: false });
    expect(validateHevcEncoderConfig({ container: "mp4" })).toMatchObject({ valid: false });
  });
});

describe("HEVC-alpha staging manifest validation", () => {
  it("accepts a manifest whose output measurements match the source contract", () => {
    expect(validateHevcEncoderManifest(validManifest)).toEqual({ valid: true, errors: [] });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, codec: "muxa" },
    })).toEqual({ valid: true, errors: [] });
  });

  it("requires the Apple alpha claim and measured output evidence", () => {
    expect(validateHevcEncoderManifest({
      ...validManifest,
      encode: { ...validManifest.encode, codec: "hevc" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, containsAlphaChannel: false },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, decodedAlphaMinimum: 255 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, decodedAlphaMaximum: 0 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      encode: { ...validManifest.encode, averageBitRate: 0 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      encode: { ...validManifest.encode, container: "mp4" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, fileName: "hero-hevc-alpha.mp4" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, codec: "hevcWithAlpha" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, frameCount: 149 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, sha256: "not-a-sha" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, height: 506, codedHeight: 506 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      encode: { ...validManifest.encode, codedHeight: 506 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, paddingRowCount: 0 },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, cleanAperture: "aperture" },
    })).toMatchObject({ valid: false });
    expect(validateHevcEncoderManifest({
      ...validManifest,
      output: { ...validManifest.output, decodedPaddingAlphaMaximum: 1 },
    })).toMatchObject({ valid: false });
  });
});

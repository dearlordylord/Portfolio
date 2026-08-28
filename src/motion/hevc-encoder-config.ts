/**
 * PROTOTYPE-ONLY contract shared by the macOS encoder documentation and
 * Linux-runnable tests. The values describe the supplied RGBA WebP archive;
 * the Swift encoder deliberately keeps these source/display dimensions fixed
 * and codes them into a 900x508 surface with one transparent bottom row.
 */

export const HEVC_ENCODER_DEFAULTS = {
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
  averageBitRate: 8_000_000,
  alphaMode: "premultiplied",
  codec: "hevcWithAlpha",
  container: "mov",
  inputPattern: "frame_%03d_delay-0.067s.webp",
} as const;

export type HevcEncoderConfig = {
  sourceWidth: number;
  sourceHeight: number;
  codedWidth: number;
  codedHeight: number;
  paddingRowCount: number;
  paddingRowEdge: string;
  paddingAlpha: string;
  cleanAperture: string;
  frameCount: number;
  frameRate: number;
  keyframeInterval: number;
  alphaQuality: number;
  averageBitRate: number;
  alphaMode: string;
  codec: string;
  container: string;
  inputPattern: string;
};

export type HevcValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
}>;

export type HevcEncoderManifest = Readonly<{
  schemaVersion: number;
  assetId: string;
  source: Readonly<{
    inputPattern: string;
    /** SHA-256 of name + NUL + bytes for each frame, in ascending index order. */
    sourceSetSha256: string;
    width: number;
    height: number;
    frameCount: number;
    frameRate: number;
    durationSeconds: number;
  }>;
  encode: Readonly<{
    codec: string;
    container: string;
    alphaMode: string;
    alphaQuality: number;
    maxKeyframeInterval: number;
    averageBitRate: number;
    codedWidth: number;
    codedHeight: number;
    contentRect: Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    paddingRowCount: number;
    paddingRowEdge: string;
    paddingAlpha: string;
    cleanAperture: string;
  }>;
  output: Readonly<{
    fileName: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    codedWidth: number;
    codedHeight: number;
    contentRect: Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    paddingRowCount: number;
    paddingRowEdge: string;
    paddingAlpha: string;
    cleanAperture: string;
    frameCount: number;
    frameRate: number;
    durationSeconds: number;
    codec: string;
    containsAlphaChannel: boolean;
    decodedAlphaMinimum: number;
    decodedAlphaMaximum: number;
    decodedContentAlphaMinimum: number;
    decodedContentAlphaMaximum: number;
    decodedPaddingAlphaMinimum: number;
    decodedPaddingAlphaMaximum: number;
  }>;
}>;

export function frameFileName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 999) {
    throw new RangeError("frame index must be an integer from 0 through 999");
  }
  return `frame_${String(index).padStart(3, "0")}_delay-0.067s.webp`;
}

export function expectedHevcDurationSeconds(
  config: Partial<HevcEncoderConfig> = {},
): number {
  const resolved = { ...HEVC_ENCODER_DEFAULTS, ...config };
  return resolved.frameCount / resolved.frameRate;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return finite(value) && Number.isInteger(value);
}

function addExactError(
  errors: string[],
  config: Record<string, unknown>,
  key: string,
  expected: unknown,
): void {
  if (config[key] !== expected) errors.push(`${key} must be ${String(expected)}`);
}

export function validateHevcEncoderConfig(
  overrides: Partial<HevcEncoderConfig> = {},
): HevcValidation {
  const config: Record<string, unknown> = { ...HEVC_ENCODER_DEFAULTS, ...overrides };
  const errors: string[] = [];

  for (const key of [
    "sourceWidth",
    "sourceHeight",
    "codedWidth",
    "codedHeight",
    "paddingRowCount",
    "frameCount",
  ] as const) {
    if (!integer(config[key]) || (config[key] as number) <= 0) {
      errors.push(String(key) + " must be a positive integer");
    }
  }
  if (!finite(config.frameRate) || (config.frameRate as number) <= 0) {
    errors.push("frameRate must be a positive number");
  }
  if (!integer(config.keyframeInterval) || (config.keyframeInterval as number) <= 0) {
    errors.push("keyframeInterval must be a positive integer");
  } else if (
    integer(config.frameCount)
    && (config.keyframeInterval as number) > (config.frameCount as number)
  ) {
    errors.push("keyframeInterval must not exceed frameCount");
  }
  if (!finite(config.alphaQuality) || (config.alphaQuality as number) < 0 || (config.alphaQuality as number) > 1) {
    errors.push("alphaQuality must be between 0 and 1");
  }
  if (!integer(config.averageBitRate) || (config.averageBitRate as number) <= 0) {
    errors.push("averageBitRate must be a positive integer");
  }
  if (config.paddingRowEdge !== HEVC_ENCODER_DEFAULTS.paddingRowEdge) {
    errors.push("paddingRowEdge must be bottom");
  }
  if (config.paddingAlpha !== HEVC_ENCODER_DEFAULTS.paddingAlpha) {
    errors.push("paddingAlpha must be transparent");
  }
  if (config.cleanAperture !== HEVC_ENCODER_DEFAULTS.cleanAperture) {
    errors.push("cleanAperture must be none");
  }
  if (
    integer(config.sourceWidth)
    && integer(config.codedWidth)
    && config.sourceWidth !== config.codedWidth
  ) {
    errors.push("codedWidth must preserve sourceWidth");
  }
  if (
    integer(config.sourceHeight)
    && integer(config.codedHeight)
    && integer(config.paddingRowCount)
    && config.codedHeight !== (config.sourceHeight as number) + (config.paddingRowCount as number)
  ) {
    errors.push("codedHeight must equal sourceHeight plus paddingRowCount");
  }

  // The source archive and the Apple writer choices are intentionally fixed
  // so a manifest cannot silently describe a different input contract.
  addExactError(errors, config, "sourceWidth", HEVC_ENCODER_DEFAULTS.sourceWidth);
  addExactError(errors, config, "sourceHeight", HEVC_ENCODER_DEFAULTS.sourceHeight);
  addExactError(errors, config, "codedWidth", HEVC_ENCODER_DEFAULTS.codedWidth);
  addExactError(errors, config, "codedHeight", HEVC_ENCODER_DEFAULTS.codedHeight);
  addExactError(errors, config, "paddingRowCount", HEVC_ENCODER_DEFAULTS.paddingRowCount);
  addExactError(errors, config, "paddingRowEdge", HEVC_ENCODER_DEFAULTS.paddingRowEdge);
  addExactError(errors, config, "paddingAlpha", HEVC_ENCODER_DEFAULTS.paddingAlpha);
  addExactError(errors, config, "cleanAperture", HEVC_ENCODER_DEFAULTS.cleanAperture);
  addExactError(errors, config, "frameCount", HEVC_ENCODER_DEFAULTS.frameCount);
  addExactError(errors, config, "frameRate", HEVC_ENCODER_DEFAULTS.frameRate);
  addExactError(errors, config, "alphaMode", HEVC_ENCODER_DEFAULTS.alphaMode);
  addExactError(errors, config, "codec", HEVC_ENCODER_DEFAULTS.codec);
  addExactError(errors, config, "container", HEVC_ENCODER_DEFAULTS.container);
  addExactError(errors, config, "inputPattern", HEVC_ENCODER_DEFAULTS.inputPattern);

  return { valid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeToExpected(value: unknown, expected: number): boolean {
  return finite(value) && Math.abs(value - expected) <= 0.5 / HEVC_ENCODER_DEFAULTS.frameRate;
}

function hasExpectedSource(source: Record<string, unknown>, errors: string[]): void {
  for (const [key, expected] of [
    ["inputPattern", HEVC_ENCODER_DEFAULTS.inputPattern],
    ["width", HEVC_ENCODER_DEFAULTS.sourceWidth],
    ["height", HEVC_ENCODER_DEFAULTS.sourceHeight],
    ["frameCount", HEVC_ENCODER_DEFAULTS.frameCount],
    ["frameRate", HEVC_ENCODER_DEFAULTS.frameRate],
  ] as const) {
    if (source[key] !== expected) {
      errors.push("source." + key + " does not match the supplied frame archive");
    }
  }
  if (typeof source.sourceSetSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sourceSetSha256)) {
    errors.push("source.sourceSetSha256 must be a 64-character hexadecimal digest");
  }
  if (!closeToExpected(source.durationSeconds, expectedHevcDurationSeconds())) {
    errors.push("source.durationSeconds does not match frameCount / frameRate");
  }
}

function hasExpectedGeometry(
  owner: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (owner.codedWidth !== HEVC_ENCODER_DEFAULTS.codedWidth) {
    errors.push(path + ".codedWidth must be " + HEVC_ENCODER_DEFAULTS.codedWidth);
  }
  if (owner.codedHeight !== HEVC_ENCODER_DEFAULTS.codedHeight) {
    errors.push(path + ".codedHeight must be " + HEVC_ENCODER_DEFAULTS.codedHeight + " (900x506 is not supported)");
  }
  if (!isRecord(owner.contentRect)) {
    errors.push(path + ".contentRect must be an object");
  } else {
    const rect = owner.contentRect;
    if (
      rect.x !== 0
      || rect.y !== 0
      || rect.width !== HEVC_ENCODER_DEFAULTS.sourceWidth
      || rect.height !== HEVC_ENCODER_DEFAULTS.sourceHeight
    ) {
      errors.push(path + ".contentRect must be x0 y0 w900 h507");
    }
  }
  if (owner.paddingRowCount !== HEVC_ENCODER_DEFAULTS.paddingRowCount) {
    errors.push(path + ".paddingRowCount must be 1");
  }
  if (owner.paddingRowEdge !== HEVC_ENCODER_DEFAULTS.paddingRowEdge) {
    errors.push(path + ".paddingRowEdge must be bottom");
  }
  if (owner.paddingAlpha !== HEVC_ENCODER_DEFAULTS.paddingAlpha) {
    errors.push(path + ".paddingAlpha must be transparent");
  }
  if (owner.cleanAperture !== HEVC_ENCODER_DEFAULTS.cleanAperture) {
    errors.push(path + ".cleanAperture must be none");
  }
}

/**
 * Validate the deterministic sidecar emitted by the Swift command. This is
 * intentionally structural and platform-independent, so CI can reject a
 * malformed or opaque export before anyone imports it into production.
 */
export function validateHevcEncoderManifest(manifest: unknown): HevcValidation {
  const errors: string[] = [];
  if (!isRecord(manifest)) return { valid: false, errors: ["manifest must be an object"] };
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof manifest.assetId !== "string" || manifest.assetId.trim() === "") {
    errors.push("assetId must be non-empty");
  }

  if (!isRecord(manifest.source)) {
    errors.push("source must be an object");
  } else {
    hasExpectedSource(manifest.source, errors);
  }

  if (!isRecord(manifest.encode)) {
    errors.push("encode must be an object");
  } else {
    if (manifest.encode.codec !== HEVC_ENCODER_DEFAULTS.codec) errors.push("encode.codec must be hevcWithAlpha");
    if (manifest.encode.container !== HEVC_ENCODER_DEFAULTS.container) errors.push("encode.container must be mov");
    if (manifest.encode.alphaMode !== HEVC_ENCODER_DEFAULTS.alphaMode) errors.push("encode.alphaMode must be premultiplied");
    if (!finite(manifest.encode.alphaQuality) || manifest.encode.alphaQuality < 0 || manifest.encode.alphaQuality > 1) {
      errors.push("encode.alphaQuality must be between 0 and 1");
    }
    if (!integer(manifest.encode.averageBitRate) || manifest.encode.averageBitRate <= 0) {
      errors.push("encode.averageBitRate must be a positive integer");
    }
    if (!integer(manifest.encode.maxKeyframeInterval) || manifest.encode.maxKeyframeInterval <= 0 || manifest.encode.maxKeyframeInterval > HEVC_ENCODER_DEFAULTS.frameCount) {
      errors.push("encode.maxKeyframeInterval must be a positive interval within the source frame count");
    }
    hasExpectedGeometry(manifest.encode, "encode", errors);
  }

  if (!isRecord(manifest.output)) {
    errors.push("output must be an object");
  } else {
    const output = manifest.output;
    if (typeof output.fileName !== "string" || !/^[^/\\]+\.mov$/i.test(output.fileName)) {
      errors.push("output.fileName must be a basename ending in .mov");
    }
    if (!integer(output.bytes) || output.bytes <= 0) errors.push("output.bytes must be positive");
    if (typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(output.sha256)) {
      errors.push("output.sha256 must be a 64-character hexadecimal digest");
    }
    for (const [key, expected] of [
      ["width", HEVC_ENCODER_DEFAULTS.codedWidth],
      ["height", HEVC_ENCODER_DEFAULTS.codedHeight],
      ["frameCount", HEVC_ENCODER_DEFAULTS.frameCount],
      ["frameRate", HEVC_ENCODER_DEFAULTS.frameRate],
    ] as const) {
      if (output[key] !== expected) errors.push("output." + key + " does not match the encoder contract");
    }
    hasExpectedGeometry(output, "output", errors);
    if (!closeToExpected(output.durationSeconds, expectedHevcDurationSeconds())) {
      errors.push("output.durationSeconds does not match the encoder contract");
    }
    if (output.codec !== "hvc1" && output.codec !== "muxa") {
      errors.push("output.codec must be the measured hvc1 or muxa fourCC");
    }
    if (output.containsAlphaChannel !== true) {
      errors.push("output.containsAlphaChannel must be true from AVFoundation validation");
    }
    if (!integer(output.decodedAlphaMinimum) || output.decodedAlphaMinimum < 0 || output.decodedAlphaMinimum > 255) {
      errors.push("output.decodedAlphaMinimum must be an 8-bit alpha value");
    }
    if (!integer(output.decodedAlphaMaximum) || output.decodedAlphaMaximum < 0 || output.decodedAlphaMaximum > 255) {
      errors.push("output.decodedAlphaMaximum must be an 8-bit alpha value");
    }
    if (
      integer(output.decodedAlphaMinimum)
      && integer(output.decodedAlphaMaximum)
      && (output.decodedAlphaMinimum as number) >= (output.decodedAlphaMaximum as number)
    ) {
      errors.push("decoded output alpha must contain both transparent and visible values");
    }
    if (!integer(output.decodedContentAlphaMinimum) || output.decodedContentAlphaMinimum < 0 || output.decodedContentAlphaMinimum > 255) {
      errors.push("output.decodedContentAlphaMinimum must be an 8-bit alpha value");
    }
    if (!integer(output.decodedContentAlphaMaximum) || output.decodedContentAlphaMaximum < 0 || output.decodedContentAlphaMaximum > 255) {
      errors.push("output.decodedContentAlphaMaximum must be an 8-bit alpha value");
    }
    if (
      integer(output.decodedContentAlphaMinimum)
      && integer(output.decodedContentAlphaMaximum)
      && (output.decodedContentAlphaMinimum as number) >= (output.decodedContentAlphaMaximum as number)
    ) {
      errors.push("decoded content alpha must contain both transparent and visible values");
    }
    if (output.decodedPaddingAlphaMinimum !== 0 || output.decodedPaddingAlphaMaximum !== 0) {
      errors.push("output.decodedPaddingAlphaMinimum/Maximum must both be 0 for every transparent padding row");
    }
  }

  return { valid: errors.length === 0, errors };
}

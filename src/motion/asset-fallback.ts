/**
 * Browser-independent asset readiness and frame fallback state.
 *
 * The renderer owns loading/decoding.  It reports the result to this module,
 * which owns the policy and the serializable diagnostics consumed by tests and
 * the runtime diagnostic surface.  Keeping those concerns separate means a
 * missing image can never be confused with an image that is still pending.
 */

export const ASSET_STATUSES = ["pending", "ready", "failed"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_READINESS_STATES = ["pending", "ready", "degraded"] as const;
export type AssetReadinessState = (typeof ASSET_READINESS_STATES)[number];

export type AssetPhase = "intro" | "later" | "optional";

/** A named failure is deliberately a string so callers can preserve decoder/network codes. */
export type AssetFailure = {
  code: string;
  message?: string;
};

export type AssetExpectation = {
  /** Stable diagnostic key.  It is not required to be a URL or a filename. */
  key: string;
  /** Numeric hero frame; omitted for skill icons and other non-frame assets. */
  frame?: number;
  /** Intro assets participate in the start policy; other assets do not. */
  phase?: AssetPhase;
};

/** String keys are convenient for icon manifests that have no frame number. */
export type AssetExpectationInput = AssetExpectation | string;

export type IntroReadinessPolicy = {
  /** Minimum number of intro assets that must be ready before playback can start. */
  minReady?: number;
  /** Minimum fraction of intro assets that must be ready; combined with minReady by max(). */
  minRatio?: number;
  /** Permit playback after the threshold when an intro asset has a named failure. */
  allowFailed?: boolean;
};

export type AssetReadinessOptions = {
  intro?: IntroReadinessPolicy;
};

export type AssetRecord = AssetExpectation & {
  status: AssetStatus;
  failure?: AssetFailure;
};

export type FrameFallbackReason = "exact" | "nearest-ready" | "no-ready-frame";

export type FrameSelection = {
  requestedFrame: number;
  renderedFrame: number | null;
  key: string | null;
  usedFallback: boolean;
  reason: FrameFallbackReason;
};

export type AssetFailureDiagnostic = {
  key: string;
  frame: number | null;
  phase: AssetPhase;
  code: string;
  message: string | null;
};

export type AssetReadinessDiagnostics = {
  state: AssetReadinessState;
  degraded: boolean;
  expected: number;
  expectedKeys: string[];
  ready: number;
  pending: number;
  failed: number;
  allReady: boolean;
  introReady: boolean;
  intro: {
    expected: number;
    required: number;
    requiredRatio: number;
    ready: number;
    pending: number;
    failed: number;
    allowFailed: boolean;
  };
  pendingKeys: string[];
  readyKeys: string[];
  failedAssets: AssetFailureDiagnostic[];
  fallbackCount: number;
  lastFrameSelection: FrameSelection | null;
  records: AssetRecord[];
};

type NormalizedExpectation = AssetExpectation & {
  phase: AssetPhase;
};

type Counts = {
  expected: number;
  ready: number;
  pending: number;
  failed: number;
  introExpected: number;
  introReady: number;
  introPending: number;
  introFailed: number;
};

const DEFAULT_FAILURE_CODE = "unknown";

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertFrame(frame: number | undefined, label: string): void {
  if (frame !== undefined && (!Number.isFinite(frame) || frame < 0)) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function normalizeFailure(failure: AssetFailure | string | undefined): AssetFailure {
  if (typeof failure === "string") {
    assertNonEmptyString(failure, "Asset failure code");
    return { code: failure };
  }
  if (failure === undefined) return { code: DEFAULT_FAILURE_CODE };
  assertNonEmptyString(failure.code, "Asset failure code");
  if (failure.message !== undefined && typeof failure.message !== "string") {
    throw new TypeError("Asset failure message must be a string when provided");
  }
  return {
    code: failure.code,
    ...(failure.message === undefined ? {} : { message: failure.message }),
  };
}

function clearFailure(record: AssetRecord): AssetRecord {
  const { failure: _failure, ...withoutFailure } = record;
  return withoutFailure;
}

function normalizeExpectations(
  expectations: readonly AssetExpectationInput[],
): NormalizedExpectation[] {
  if (!Array.isArray(expectations)) {
    throw new TypeError("Expected assets must be an array");
  }

  const seen = new Set<string>();
  return expectations.map((input, index) => {
    const expectation = typeof input === "string" ? { key: input } : input;
    if (!expectation || typeof expectation !== "object") {
      throw new TypeError(`Asset expectation ${index} must be an object`);
    }
    assertNonEmptyString(expectation.key, `Asset expectation ${index} key`);
    if (seen.has(expectation.key)) {
      throw new Error(`Duplicate asset expectation key: ${expectation.key}`);
    }
    seen.add(expectation.key);
    assertFrame(expectation.frame, `Asset expectation ${expectation.key} frame`);
    const phase = expectation.phase ?? (expectation.frame !== undefined ? "later" : "optional");
    if (phase !== "intro" && phase !== "later" && phase !== "optional") {
      throw new TypeError(`Unknown asset phase: ${String(phase)}`);
    }
    return {
      key: expectation.key,
      ...(expectation.frame === undefined ? {} : { frame: expectation.frame }),
      phase,
    };
  });
}

function normalizePolicy(
  policy: IntroReadinessPolicy | undefined,
  introExpected: number,
): Required<IntroReadinessPolicy> {
  const minReady = policy?.minReady;
  const minRatio = policy?.minRatio;
  if (minReady !== undefined && (!Number.isInteger(minReady) || minReady < 0)) {
    throw new RangeError("intro.minReady must be a finite non-negative integer");
  }
  if (minRatio !== undefined && (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1)) {
    throw new RangeError("intro.minRatio must be between 0 and 1");
  }
  if (minReady !== undefined && minReady > introExpected) {
    throw new RangeError("intro.minReady cannot exceed the number of intro assets");
  }

  const ratioMinimum = minRatio === undefined ? 0 : Math.ceil(introExpected * minRatio);
  const required = Math.min(
    introExpected,
    Math.max(minReady ?? 0, ratioMinimum, minReady === undefined && minRatio === undefined ? introExpected : 0),
  );
  return {
    minReady: required,
    minRatio: minRatio ?? (introExpected === 0 ? 1 : required / introExpected),
    allowFailed: policy?.allowFailed ?? false,
  };
}

/**
 * Select the closest ready frame without relying on insertion order.
 *
 * Equal distances prefer the lower frame, then the lexicographically smaller
 * key when two assets describe the same frame.  The latter makes malformed or
 * aliased frame manifests deterministic too.
 */
export function selectNearestReadyFrame(
  requestedFrame: number,
  candidates: readonly { frame: number; key: string }[],
): FrameSelection {
  if (!Number.isFinite(requestedFrame) || requestedFrame < 0) {
    throw new RangeError("Requested frame must be a finite non-negative number");
  }

  if (!Array.isArray(candidates)) throw new TypeError("Frame candidates must be an array");
  const ready = candidates
    .filter(
      (candidate) =>
        Boolean(candidate) && Number.isFinite(candidate.frame) && candidate.frame >= 0,
    )
    .map((candidate) => {
      assertNonEmptyString(candidate.key, "Frame candidate key");
      return { frame: candidate.frame, key: candidate.key };
    });
  if (ready.length === 0) {
    return {
      requestedFrame,
      renderedFrame: null,
      key: null,
      usedFallback: true,
      reason: "no-ready-frame",
    };
  }

  ready.sort((left, right) => {
    const distance = Math.abs(left.frame - requestedFrame) - Math.abs(right.frame - requestedFrame);
    if (distance !== 0) return distance;
    if (left.frame !== right.frame) return left.frame - right.frame;
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return 0;
  });
  const selected = ready[0];
  const exact = selected.frame === requestedFrame;
  return {
    requestedFrame,
    renderedFrame: selected.frame,
    key: selected.key,
    usedFallback: !exact,
    reason: exact ? "exact" : "nearest-ready",
  };
}

/**
 * Mutable readiness registry.  Its mutation surface mirrors Image onload,
 * onerror, and decode completion while its output remains plain JSON data.
 */
export class AssetReadinessRegistry {
  readonly #expectations: readonly NormalizedExpectation[];
  readonly #records = new Map<string, AssetRecord>();
  readonly #introPolicy: Required<IntroReadinessPolicy>;
  #fallbackCount = 0;
  #lastFrameSelection: FrameSelection | null = null;

  constructor(
    expectations: readonly AssetExpectationInput[],
    options: AssetReadinessOptions = {},
  ) {
    this.#expectations = normalizeExpectations(expectations);
    const introExpected = this.#expectations.filter((asset) => asset.phase === "intro").length;
    this.#introPolicy = normalizePolicy(options.intro, introExpected);
    for (const expectation of this.#expectations) {
      this.#records.set(expectation.key, { ...expectation, status: "pending" });
    }
  }

  get expectations(): readonly AssetExpectation[] {
    return this.#expectations.map(({ key, frame, phase }) => ({
      key,
      ...(frame === undefined ? {} : { frame }),
      phase,
    }));
  }

  get state(): AssetReadinessState {
    const counts = this.#counts();
    if (this.#isDegraded(counts)) return "degraded";
    if (this.#isIntroReady(counts)) return "ready";
    return "pending";
  }

  get degraded(): boolean {
    return this.state === "degraded";
  }

  get introReady(): boolean {
    return this.#isIntroReady(this.#counts());
  }

  get allReady(): boolean {
    return this.#counts().ready === this.#expectations.length;
  }

  get fallbackCount(): number {
    return this.#fallbackCount;
  }

  status(key: string): AssetStatus {
    return this.#record(key).status;
  }

  record(key: string): AssetRecord {
    const record = this.#record(key);
    return { ...record, ...(record.failure ? { failure: { ...record.failure } } : {}) };
  }

  markPending(key: string): void {
    const record = this.#record(key);
    this.#records.set(key, { ...clearFailure(record), status: "pending" });
  }

  markReady(key: string): void {
    const record = this.#record(key);
    this.#records.set(key, { ...clearFailure(record), status: "ready" });
  }

  markFailed(key: string, failure?: AssetFailure | string): void {
    const record = this.#record(key);
    this.#records.set(key, {
      ...record,
      status: "failed",
      failure: normalizeFailure(failure),
    });
  }

  /** Alias matching a loader's usual callback vocabulary. */
  ready(key: string): void {
    this.markReady(key);
  }

  /** Alias matching a loader's usual callback vocabulary. */
  failed(key: string, failure?: AssetFailure | string): void {
    this.markFailed(key, failure);
  }

  selectNearestReadyFrame(requestedFrame: number): FrameSelection {
    const candidates = this.#expectations
      .filter((asset): asset is NormalizedExpectation & { frame: number } =>
        asset.frame !== undefined && this.#records.get(asset.key)?.status === "ready",
      )
      .map((asset) => ({ frame: asset.frame, key: asset.key }));
    const selection = selectNearestReadyFrame(requestedFrame, candidates);
    this.#lastFrameSelection = selection;
    if (selection.usedFallback) this.#fallbackCount += 1;
    return { ...selection };
  }

  /** Short alias for renderers that already know they are selecting a frame. */
  selectFrame(requestedFrame: number): FrameSelection {
    return this.selectNearestReadyFrame(requestedFrame);
  }

  diagnostics(): AssetReadinessDiagnostics {
    const counts = this.#counts();
    const records = this.#expectations.map((expectation) => {
      const record = this.#records.get(expectation.key)!;
      return {
        ...record,
        ...(record.failure ? { failure: { ...record.failure } } : {}),
      };
    });
    const failedAssets = records
      .filter((record) => record.status === "failed")
      .map((record) => ({
        key: record.key,
        frame: record.frame ?? null,
        phase: record.phase ?? "optional",
        code: record.failure?.code ?? DEFAULT_FAILURE_CODE,
        message: record.failure?.message ?? null,
      }));
    return {
      state: this.state,
      degraded: this.degraded,
      expected: counts.expected,
      expectedKeys: records.map((record) => record.key),
      ready: counts.ready,
      pending: counts.pending,
      failed: counts.failed,
      allReady: this.allReady,
      introReady: this.#isIntroReady(counts),
      intro: {
        expected: counts.introExpected,
        required: this.#introPolicy.minReady,
        requiredRatio: this.#introPolicy.minRatio,
        ready: counts.introReady,
        pending: counts.introPending,
        failed: counts.introFailed,
        allowFailed: this.#introPolicy.allowFailed,
      },
      pendingKeys: records.filter((record) => record.status === "pending").map((record) => record.key),
      readyKeys: records.filter((record) => record.status === "ready").map((record) => record.key),
      failedAssets,
      fallbackCount: this.#fallbackCount,
      lastFrameSelection: this.#lastFrameSelection ? { ...this.#lastFrameSelection } : null,
      records,
    };
  }

  /** Alias used by diagnostic APIs that call all snapshots `snapshot`. */
  snapshot(): AssetReadinessDiagnostics {
    return this.diagnostics();
  }

  #record(key: string): AssetRecord {
    assertNonEmptyString(key, "Asset key");
    const record = this.#records.get(key);
    if (!record) throw new Error(`Unknown asset key: ${key}`);
    return record;
  }

  #counts(): Counts {
    let ready = 0;
    let pending = 0;
    let failed = 0;
    let introReady = 0;
    let introPending = 0;
    let introFailed = 0;
    for (const record of this.#records.values()) {
      if (record.status === "ready") ready += 1;
      else if (record.status === "pending") pending += 1;
      else failed += 1;
      if (record.phase === "intro") {
        if (record.status === "ready") introReady += 1;
        else if (record.status === "pending") introPending += 1;
        else introFailed += 1;
      }
    }
    return {
      expected: this.#records.size,
      ready,
      pending,
      failed,
      introExpected: introReady + introPending + introFailed,
      introReady,
      introPending,
      introFailed,
    };
  }

  #isIntroReady(counts: Counts): boolean {
    // When failures are explicitly allowed, a settled failure occupies an
    // intro slot just like a ready frame.  This is important for a full
    // intro manifest: with `minReady` equal to the number of intro frames,
    // requiring every surviving frame to be ready would make one missing
    // frame an impossible threshold and leave playback pending forever.
    const settled = counts.introReady + (this.#introPolicy.allowFailed ? counts.introFailed : 0);
    if (settled < this.#introPolicy.minReady) return false;
    return this.#introPolicy.allowFailed || counts.introFailed === 0;
  }

  #isDegraded(counts: Counts): boolean {
    if (counts.failed === 0) return false;
    if (counts.introFailed > 0 && !this.#introPolicy.allowFailed) return true;
    // Once all intro attempts have settled, an unmet threshold can no longer
    // become ready and must be reported as an explicit degraded state.
    if (counts.introPending === 0 && counts.introReady < this.#introPolicy.minReady) return true;
    return this.#isIntroReady(counts);
  }
}

export function createAssetReadinessRegistry(
  expectations: readonly AssetExpectationInput[],
  options?: AssetReadinessOptions,
): AssetReadinessRegistry {
  return new AssetReadinessRegistry(expectations, options);
}

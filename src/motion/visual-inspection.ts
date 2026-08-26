/**
 * Data contracts for the visual inspection lane.
 *
 * This module deliberately contains no DOM, canvas, or Playwright code. A
 * browser adapter records facts into these shapes and this module classifies
 * the facts. Missing facts are never treated as a passing measurement.
 */

export type InspectionEvidenceKind = "synthetic-browser" | "real-device";

export type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>;

export type InspectionCheckpoint =
  | "hero-role"
  | "hero-experience"
  | "hero-terminal"
  | "below-hero"
  | "hero-return"
  | "timeline";

export type ViewportInsets = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type ViewportSize = Readonly<{
  width: number;
  height: number;
}>;

export const BACKGROUND_SAMPLE_TOPOLOGY = "first-screen-edge-pairs-v1" as const;
export const BACKGROUND_SAMPLE_REGIONS = [
  "top-left",
  "top-right",
  "upper-left",
  "upper-right",
  "middle-left",
  "middle-right",
  "lower-left",
  "lower-right",
] as const;
export type BackgroundSampleRegion = (typeof BACKGROUND_SAMPLE_REGIONS)[number];
export type BackgroundSamplePoint = Readonly<{
  region: BackgroundSampleRegion;
  x: number;
  y: number;
}>;
export const BACKGROUND_SAMPLE_POINTS: readonly BackgroundSamplePoint[] = [
  { region: "top-left", x: 0.08, y: 0.08 },
  { region: "top-right", x: 0.92, y: 0.08 },
  { region: "upper-left", x: 0.08, y: 0.25 },
  { region: "upper-right", x: 0.92, y: 0.25 },
  { region: "middle-left", x: 0.08, y: 0.5 },
  { region: "middle-right", x: 0.92, y: 0.5 },
  { region: "lower-left", x: 0.08, y: 0.7 },
  { region: "lower-right", x: 0.92, y: 0.7 },
];
export const BACKGROUND_OWNER = "#scrolly" as const;
export const BACKGROUND_SAMPLE_COORDINATE_TOLERANCE = 0.005;

const BACKGROUND_HIT_STACK_ALLOWLIST = new Set([
  "#scrolly",
  "#scrolly-sticky",
  "#scrolly-canvas",
  "body",
  "html",
]);

/** A pixel whose ownership and coordinate spaces were recorded by the probe. */
export type BackgroundPixelSample = Readonly<{
  /** Stable name from `BACKGROUND_SAMPLE_REGIONS`; names prevent point drift. */
  region: BackgroundSampleRegion;
  /** CSS viewport coordinates used to choose the sample. */
  css: Readonly<{ x: number; y: number }>;
  /** Bitmap coordinates actually read from the screenshot/canvas. */
  bitmap: Readonly<{ x: number; y: number }>;
  /** Size of the bitmap patch averaged into `rgba`. */
  patch: Readonly<{ width: number; height: number }>;
  rgba: Rgba;
  /** Selectors/labels returned by the hit-test stack at the CSS point. */
  hitStack: readonly string[];
  /** Explicit probe decision that this point contains background only. */
  backgroundOnly: boolean;
}>;

/**
 * Samples from named regions of the rendered first-screen surface. The
 * foreground is rejected structurally and high-frequency texture is averaged
 * over each centered patch; no hidden or synthetic surface is substituted.
 */
export type BackgroundSampleSet = Readonly<{
  source: "rendered-first-screen";
  owner: string;
  topology: typeof BACKGROUND_SAMPLE_TOPOLOGY;
  regions: readonly BackgroundSampleRegion[];
  cssViewport: ViewportSize;
  bitmap: ViewportSize;
  devicePixelRatio: number;
  expectedCount: number;
  samples: readonly BackgroundPixelSample[];
  /** High-frequency texture is averaged over each recorded patch. */
  texture: "patch-averaged" | "included" | "unknown";
}>;

export type HeroCopySnapshot = Readonly<{
  /** The semantic textContent, normalized only by the evaluator. */
  text: string;
  display: string;
  visibility: string;
  opacity: number;
  rect: Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
  /** IntersectionObserver/geometry result against the visual viewport. */
  viewportIntersection: boolean;
  /** Ancestor clipping was checked by the browser adapter. */
  unclipped: boolean;
  /** Hit testing found no other element over the semantic copy. */
  occluded: boolean;
}>;

export type HeroPersistenceSample = HeroCopySnapshot &
  Readonly<{
    /** Delay after the return-to-hero checkpoint at which this was sampled. */
    delayMs: number;
  }>;

export type HeroObservation = Readonly<{
  phase: string;
  targetFrame: number;
  displayFrame: number;
  /** Legacy diagnostic scalars remain readable for report compatibility. */
  experienceOpacity: number;
  computedExperienceOpacity: number;
  experience?: HeroCopySnapshot;
  /** At least two strictly delayed samples are required for R3 return proof. */
  persistenceSamples?: readonly HeroPersistenceSample[];
}>;

export type TimelineSemanticAnchorKind =
  "title" | "header" | "year" | "body" | "body-descendant";

export type TimelineSemanticAnchor = Readonly<{
  kind: TimelineSemanticAnchorKind;
  id: string;
  label: string;
  left: number;
  visible: boolean;
  width: number;
  height: number;
  readable: boolean;
}>;

export type TimelineSemanticRow = Readonly<{
  id: string;
  year: TimelineSemanticAnchor;
  body: TimelineSemanticAnchor;
  readableBodyDescendants: readonly TimelineSemanticAnchor[];
}>;

/**
 * Exhaustive semantic timeline anchors. The spine, dots, track, and other
 * decoration are intentionally not represented here: only visible content
 * that a user can read participates in the gutter contract.
 */
export type TimelineSemanticInspection = Readonly<{
  complete: boolean;
  header: TimelineSemanticAnchor | null;
  title: TimelineSemanticAnchor | null;
  rowCount: number;
  rows: readonly TimelineSemanticRow[];
}>;

export type VisualProbeObservation = Readonly<{
  viewport: {
    layoutWidth: number;
    layoutHeight: number;
    visualWidth: number;
    visualHeight: number;
    visualOffsetTop: number;
    visualOffsetLeft: number;
    visualScale: number;
    insets: ViewportInsets;
  };
  surfaces: {
    html: string;
    body: string;
    scrolly: string;
    sticky: string;
    loader: string;
    canvasPixels: readonly Rgba[];
    /** Deprecated raw final-composite pixels; never used as R2 proof. */
    compositedPixels: readonly Rgba[];
    /** Required for R2; samples named rendered first-screen regions. */
    backgroundSamples?: BackgroundSampleSet;
    noiseImage: string;
  };
  insets: {
    standardSectionGutter: number;
    timelineHeader: number;
    timelineTrack: number;
    timelineFirstContent: number;
    /** Required for R4; old scalar anchors are report context only. */
    timelineSemantic?: TimelineSemanticInspection;
  };
  document: {
    scrollX: number;
    scrollY: number;
    scrollWidth: number;
    clientWidth: number;
  };
}>;

export type BrowserChromeFrame = Readonly<{
  screenshot: string;
  curtainVisible: boolean;
}>;

/** Paired, human-reviewed states are required; one screenshot is insufficient. */
export type BrowserChromeReview = Readonly<{
  expanded: BrowserChromeFrame;
  collapsed: BrowserChromeFrame;
  reviewedAt: string;
}>;

export type VisualScenarioObservation = Readonly<{
  /** Groups terminal and return evidence into one capture scenario. */
  scenarioId: string;
  evidence: InspectionEvidenceKind;
  checkpoint: InspectionCheckpoint;
  probe: VisualProbeObservation;
  hero: HeroObservation;
  browserChrome?: BrowserChromeReview;
}>;

export type ConvergenceStatus = "met" | "unmet" | "inconclusive";

export type ConvergenceFinding = Readonly<{
  requirement: "R1" | "R2" | "R3" | "R4";
  status: ConvergenceStatus;
  metric: string;
  expected: string;
  observed: string;
  evidence: InspectionEvidenceKind;
}>;

export const BACKGROUND_UNIFORMITY_TOLERANCE = 2;
export const TIMELINE_GUTTER_TOLERANCE_PX = 1;

function channelSpread(colors: readonly Rgba[]): number {
  if (colors.length < 2) return 0;
  return Math.max(
    ...(["r", "g", "b"] as const).map((channel) => {
      const values = colors.map((color) => color[channel]);
      return Math.max(...values) - Math.min(...values);
    }),
  );
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidViewportSize(size: ViewportSize): boolean {
  return isPositiveFinite(size.width) && isPositiveFinite(size.height);
}

function isValidRgba(color: Rgba): boolean {
  return [color.r, color.g, color.b, color.a].every(
    (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
  );
}

function isValidBackgroundSampleSet(
  set: BackgroundSampleSet | undefined,
): boolean {
  if (
    !set ||
    set.source !== "rendered-first-screen" ||
    set.owner !== BACKGROUND_OWNER
  )
    return false;
  if (set.topology !== BACKGROUND_SAMPLE_TOPOLOGY) return false;
  if (
    set.regions.length !== BACKGROUND_SAMPLE_REGIONS.length ||
    set.regions.some(
      (region, index) => region !== BACKGROUND_SAMPLE_REGIONS[index],
    )
  )
    return false;
  if (!isValidViewportSize(set.cssViewport) || !isValidViewportSize(set.bitmap))
    return false;
  if (
    !Number.isInteger(set.bitmap.width) ||
    !Number.isInteger(set.bitmap.height)
  )
    return false;
  if (!isPositiveFinite(set.devicePixelRatio)) return false;
  if (set.expectedCount !== BACKGROUND_SAMPLE_REGIONS.length) return false;
  if (
    set.samples.length !== BACKGROUND_SAMPLE_REGIONS.length ||
    set.texture !== "patch-averaged"
  )
    return false;

  const sampleRegions = set.samples.map((sample) => sample.region);
  if (
    sampleRegions.some(
      (region, index) => region !== BACKGROUND_SAMPLE_REGIONS[index],
    ) ||
    new Set(sampleRegions).size !== BACKGROUND_SAMPLE_REGIONS.length
  )
    return false;

  return set.samples.every((sample, index) => {
    const cssInBounds =
      isFiniteNumber(sample.css.x) &&
      isFiniteNumber(sample.css.y) &&
      sample.css.x >= 0 &&
      sample.css.x < set.cssViewport.width &&
      sample.css.y >= 0 &&
      sample.css.y < set.cssViewport.height;
    const bitmapInBounds =
      Number.isInteger(sample.bitmap.x) &&
      Number.isInteger(sample.bitmap.y) &&
      sample.bitmap.x >= 0 &&
      sample.bitmap.x < set.bitmap.width &&
      sample.bitmap.y >= 0 &&
      sample.bitmap.y < set.bitmap.height;
    const mapped =
      Math.abs(sample.bitmap.x - sample.css.x * set.devicePixelRatio) <= 1 &&
      Math.abs(sample.bitmap.y - sample.css.y * set.devicePixelRatio) <= 1;
    const validPatch =
      Number.isInteger(sample.patch.width) &&
      Number.isInteger(sample.patch.height) &&
      sample.patch.width >= 8 &&
      sample.patch.height >= 8 &&
      sample.bitmap.x - Math.floor(sample.patch.width / 2) >= 0 &&
      sample.bitmap.y - Math.floor(sample.patch.height / 2) >= 0 &&
      sample.bitmap.x - Math.floor(sample.patch.width / 2) + sample.patch.width <= set.bitmap.width &&
      sample.bitmap.y - Math.floor(sample.patch.height / 2) + sample.patch.height <= set.bitmap.height;
    const expectedPoint = BACKGROUND_SAMPLE_POINTS[index];
    const normalizedPoint = expectedPoint
      ? {
          x: sample.css.x / set.cssViewport.width,
          y: sample.css.y / set.cssViewport.height,
        }
      : undefined;
    const canonicalCoordinate = Boolean(
      expectedPoint &&
        expectedPoint.region === sample.region &&
        normalizedPoint &&
        Math.abs(normalizedPoint.x - expectedPoint.x) <=
          BACKGROUND_SAMPLE_COORDINATE_TOLERANCE &&
        Math.abs(normalizedPoint.y - expectedPoint.y) <=
          BACKGROUND_SAMPLE_COORDINATE_TOLERANCE,
    );
    return (
      cssInBounds &&
      bitmapInBounds &&
      mapped &&
      validPatch &&
      canonicalCoordinate &&
      isValidRgba(sample.rgba) &&
      sample.rgba.a === 255 &&
      sample.backgroundOnly &&
      sample.hitStack.length > 0 &&
      sample.hitStack.includes(set.owner) &&
      sample.hitStack.every((selector) =>
        BACKGROUND_HIT_STACK_ALLOWLIST.has(selector),
      )
    );
  });
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isExperienceCopyText(text: string): boolean {
  return /14\+\s*(?:years?|лет)/iu.test(normalizedText(text));
}

type CopyState = "valid" | "invalid" | "missing";

function classifyCopy(snapshot: HeroCopySnapshot | undefined): CopyState {
  if (!snapshot) return "missing";
  const rect = snapshot.rect;
  if (
    typeof snapshot.text !== "string" ||
    !isExperienceCopyText(snapshot.text) ||
    typeof snapshot.display !== "string" ||
    snapshot.display.toLocaleLowerCase() === "none" ||
    typeof snapshot.visibility !== "string" ||
    snapshot.visibility.toLocaleLowerCase() !== "visible" ||
    !Number.isFinite(snapshot.opacity) ||
    snapshot.opacity < 0.95 ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !snapshot.viewportIntersection ||
    !snapshot.unclipped ||
    snapshot.occluded
  ) {
    return "invalid";
  }
  return "valid";
}

function validBrowserChromeReview(
  review: BrowserChromeReview | undefined,
): boolean {
  if (!review) return false;
  if (!review.reviewedAt || !Number.isFinite(Date.parse(review.reviewedAt)))
    return false;
  return [review.expanded, review.collapsed].every(
    (frame) =>
      Boolean(frame?.screenshot?.trim()) &&
      typeof frame?.curtainVisible === "boolean",
  );
}

function semanticAnchors(
  inspection: TimelineSemanticInspection | undefined,
): TimelineSemanticAnchor[] | null {
  if (
    !inspection ||
    !inspection.complete ||
    !inspection.title ||
    !inspection.header
  )
    return null;
  if (
    !Number.isInteger(inspection.rowCount) ||
    inspection.rowCount <= 0 ||
    inspection.rows.length !== inspection.rowCount
  )
    return null;
  const rows = inspection.rows;
  const anchors = [
    inspection.title,
    inspection.header,
    ...rows.flatMap((row) => [
      row.year,
      row.body,
      ...row.readableBodyDescendants,
    ]),
  ];
  const ids = anchors.map((anchor) => anchor.id);
  if (
    new Set(ids).size !== ids.length ||
    anchors.some(
      (anchor) =>
        !anchor.id.trim() ||
        !anchor.label.trim() ||
        !Number.isFinite(anchor.left) ||
        !anchor.visible ||
        !Number.isFinite(anchor.width) ||
        !Number.isFinite(anchor.height) ||
        anchor.width <= 0 ||
        anchor.height <= 0 ||
        (anchor.kind !== "title" &&
          anchor.kind !== "header" &&
          anchor.kind !== "year" &&
          anchor.kind !== "body" &&
          anchor.kind !== "body-descendant"),
    )
  ) {
    return null;
  }
  if (
    inspection.title.kind !== "title" ||
    inspection.header.kind !== "header" ||
    !inspection.title.readable ||
    !inspection.header.readable
  )
    return null;
  if (
    rows.some(
      (row) =>
        !row.id.trim() ||
        row.year.kind !== "year" ||
        row.body.kind !== "body" ||
        !row.body.readable ||
        row.readableBodyDescendants.length === 0 ||
        row.readableBodyDescendants.some(
          (anchor) => anchor.kind !== "body-descendant" || !anchor.readable,
        ),
    )
  )
    return null;
  const rowIds = rows.map((row) => row.id);
  if (new Set(rowIds).size !== rowIds.length) return null;
  return anchors;
}

function byCheckpointAndEvidence(
  observations: readonly VisualScenarioObservation[],
  checkpoint: InspectionCheckpoint,
  evidence?: InspectionEvidenceKind,
): VisualScenarioObservation[] {
  return observations.filter(
    (observation) =>
      observation.checkpoint === checkpoint &&
      (evidence === undefined || observation.evidence === evidence),
  );
}

function statusFromStates(states: readonly CopyState[]): ConvergenceStatus {
  if (states.length === 0 || states.includes("missing")) return "inconclusive";
  return states.includes("invalid") ? "unmet" : "met";
}

export function computeViewportInsets(input: {
  innerWidth: number;
  innerHeight: number;
  visualWidth: number;
  visualHeight: number;
  offsetTop: number;
  offsetLeft: number;
}): ViewportInsets {
  return {
    top: Math.max(0, input.offsetTop),
    left: Math.max(0, input.offsetLeft),
    right: Math.max(0, input.innerWidth - input.offsetLeft - input.visualWidth),
    bottom: Math.max(
      0,
      input.innerHeight - input.offsetTop - input.visualHeight,
    ),
  };
}

/**
 * Evaluate the four currently reported symptoms without changing runtime
 * behavior. Every requirement selects observations by checkpoint *and*
 * evidence kind; a later observation cannot silently overwrite an earlier
 * observation from another lane.
 */
export function evaluateVisualConvergence(
  observations: readonly VisualScenarioObservation[],
): ConvergenceFinding[] {
  const roleObservations = byCheckpointAndEvidence(observations, "hero-role");
  const terminalObservations = byCheckpointAndEvidence(
    observations,
    "hero-terminal",
  );
  const returnedObservations = byCheckpointAndEvidence(
    observations,
    "hero-return",
  );
  const timelineObservations = byCheckpointAndEvidence(
    observations,
    "timeline",
  );
  const evidenceFor = (
    values: readonly VisualScenarioObservation[],
  ): InspectionEvidenceKind => values[0]?.evidence ?? "synthetic-browser";

  const realDeviceRole = roleObservations.filter(
    (observation) => observation.evidence === "real-device",
  );
  const reviewedDeviceRoles = realDeviceRole.filter((observation) =>
    validBrowserChromeReview(observation.browserChrome),
  );
  const allDeviceReviewsValid =
    realDeviceRole.length > 0 &&
    reviewedDeviceRoles.length === realDeviceRole.length;
  const r1Status: ConvergenceStatus = !allDeviceReviewsValid
    ? "inconclusive"
    : reviewedDeviceRoles.some(
          (observation) =>
            observation.browserChrome!.expanded.curtainVisible ||
            observation.browserChrome!.collapsed.curtainVisible,
        )
      ? "unmet"
      : "met";
  const r1Observed = reviewedDeviceRoles.length
    ? reviewedDeviceRoles
        .map((observation) => {
          const review = observation.browserChrome!;
          return `expanded=${review.expanded.curtainVisible}; collapsed=${review.collapsed.curtainVisible}; inset=${observation.probe.viewport.insets.bottom.toFixed(1)}px`;
        })
        .join(" | ")
    : `${roleObservations[0]?.probe.viewport.insets.bottom.toFixed(1) ?? "n/a"}px inset; no paired real-device browser-chrome review`;

  const r2Checkpoints = [
    "hero-role",
    "hero-experience",
    "hero-terminal",
  ] as const;
  const r2Observations = r2Checkpoints.flatMap((checkpoint) =>
    byCheckpointAndEvidence(observations, checkpoint, "synthetic-browser"),
  );
  const r2CheckpointCardinalityValid = r2Checkpoints.every(
    (checkpoint) =>
      byCheckpointAndEvidence(observations, checkpoint, "synthetic-browser")
        .length === 1,
  );
  const r2MissingCheckpoint = r2Checkpoints.some(
    (checkpoint) =>
      byCheckpointAndEvidence(observations, checkpoint, "synthetic-browser")
        .length === 0,
  );
  const validBackgroundSets = r2Observations
    .map((observation) => observation.probe.surfaces.backgroundSamples)
    .filter((set): set is BackgroundSampleSet =>
      isValidBackgroundSampleSet(set),
    );
  const allBackgroundSetsValid =
    r2CheckpointCardinalityValid &&
    !r2MissingCheckpoint &&
    r2Observations.length > 0 &&
    validBackgroundSets.length === r2Observations.length;
  const backgroundSpreads = validBackgroundSets.map((set) =>
    channelSpread(set.samples.map((sample) => sample.rgba)),
  );
  const r2Status: ConvergenceStatus = !allBackgroundSetsValid
    ? "inconclusive"
    : backgroundSpreads.some(
          (spread) => spread > BACKGROUND_UNIFORMITY_TOLERANCE,
        )
      ? "unmet"
      : "met";
  const r2Observed = backgroundSpreads.length
    ? r2Observations
        .map(
          (observation, index) =>
            `${observation.checkpoint}=${backgroundSpreads[index] ?? "invalid"} spread`,
        )
        .join(" | ")
    : "missing valid rendered first-screen background sample sets for synthetic role/experience/terminal";

  const syntheticTerminalObservations = byCheckpointAndEvidence(
    observations,
    "hero-terminal",
    "synthetic-browser",
  );
  const syntheticReturnObservations = byCheckpointAndEvidence(
    observations,
    "hero-return",
    "synthetic-browser",
  );
  const scenarioIds = [
    ...syntheticTerminalObservations.map(
      (observation) => observation.scenarioId,
    ),
    ...syntheticReturnObservations.map((observation) => observation.scenarioId),
  ];
  const coherentScenario =
    syntheticTerminalObservations.length === 1 &&
    syntheticReturnObservations.length === 1 &&
    scenarioIds.every(
      (scenarioId) => typeof scenarioId === "string" && scenarioId.trim(),
    ) &&
    new Set(scenarioIds).size === 1;
  const syntheticTerminal = syntheticTerminalObservations[0];
  const syntheticReturn = syntheticReturnObservations[0];
  const terminalStates =
    coherentScenario && syntheticTerminal
      ? [
          syntheticTerminal.hero.phase === "complete"
            ? classifyCopy(syntheticTerminal.hero.experience)
            : ("invalid" as const),
        ]
      : [];
  const terminalStatus = coherentScenario
    ? statusFromStates(terminalStates)
    : "inconclusive";

  const persistenceSamples = syntheticReturn?.hero.persistenceSamples ?? [];
  const delays = persistenceSamples.map((sample) => sample.delayMs);
  const persistenceShapeValid =
    coherentScenario &&
    delays.length >= 3 &&
    delays[0] === 0 &&
    delays.some((delay) => delay >= 500) &&
    delays.some((delay) => delay >= 2_000) &&
    delays.every(
      (delay, index) =>
        Number.isFinite(delay) &&
        delay >= 0 &&
        (index === 0 || delay > delays[index - 1]!),
    );
  const returnStates =
    coherentScenario && syntheticReturn
      ? [
          syntheticReturn.hero.phase === "complete" ||
          syntheticReturn.hero.phase === "released"
            ? persistenceSamples.map((sample) => classifyCopy(sample))
            : ["invalid" as const],
        ].flat()
      : [];
  const returnStatus: ConvergenceStatus =
    !coherentScenario || !persistenceShapeValid
      ? "inconclusive"
      : statusFromStates(returnStates);
  const r3Status: ConvergenceStatus =
    terminalStatus === "unmet" || returnStatus === "unmet"
      ? "unmet"
      : terminalStatus === "inconclusive" || returnStatus === "inconclusive"
        ? "inconclusive"
        : "met";
  const r3Observed = `scenario=${coherentScenario ? scenarioIds[0] : "incoherent/missing"}; terminal=${terminalStates.length ? terminalStates.join(",") : "missing"}; return=${returnStates.length ? returnStates.join(",") : "missing"}; delays=${delays.length ? delays.join(",") : "missing"}`;

  const timelineStates = timelineObservations.map((observation) => {
    const anchors = semanticAnchors(observation.probe.insets.timelineSemantic);
    const gutter = observation.probe.insets.standardSectionGutter;
    if (!anchors || !Number.isFinite(gutter))
      return {
        status: "inconclusive" as const,
        observed: "missing exhaustive semantic anchors",
      };
    const minimum = Math.min(...anchors.map((anchor) => anchor.left));
    const offenders = anchors.filter(
      (anchor) => anchor.left < gutter - TIMELINE_GUTTER_TOLERANCE_PX,
    );
    return {
      status: offenders.length > 0 ? ("unmet" as const) : ("met" as const),
      observed: `gutter=${gutter.toFixed(1)}px; minimum=${minimum.toFixed(1)}px; offenders=${offenders.length ? offenders.map((anchor) => `${anchor.kind}:${anchor.label}=${anchor.left.toFixed(1)}px`).join(",") : "none"}`,
    };
  });
  const r4Status: ConvergenceStatus =
    timelineStates.length === 0 ||
    timelineStates.some((state) => state.status === "inconclusive")
      ? "inconclusive"
      : timelineStates.some((state) => state.status === "unmet")
        ? "unmet"
        : "met";
  const r4Observed = timelineStates.length
    ? timelineStates.map((state) => state.observed).join(" | ")
    : "missing timeline checkpoint";

  return [
    {
      requirement: "R1",
      status: r1Status,
      metric: "paired real-device browser-chrome curtain review",
      expected:
        "expanded and collapsed screenshots both reviewed with no exposed bottom curtain; visual-viewport inset is context only",
      observed: r1Observed,
      evidence:
        reviewedDeviceRoles[0]?.evidence ?? evidenceFor(roleObservations),
    },
    {
      requirement: "R2",
      status: r2Status,
      metric: "rendered first-screen background continuity",
      expected:
        "exact structured named-region patch averages from #scrolly, high-frequency texture averaged, ≤2 RGB-channel spread",
      observed: r2Observed,
      evidence: evidenceFor(roleObservations),
    },
    {
      requirement: "R3",
      status: r3Status,
      metric: "14+ years terminal persistence",
      expected:
        "semantic 14+ years copy is visible at terminal and remains visible at return samples scheduled for 0ms, ≥500ms, and ≥2000ms in one coherent synthetic scenario",
      observed: r3Observed,
      evidence: evidenceFor(terminalObservations),
    },
    {
      requirement: "R4",
      status: r4Status,
      metric: "semantic timeline left edges not left of shared gutter",
      expected:
        "title, header, and every uniquely identified visible/nonzero year/body row with readable body descendants are exhaustive and not left of the shared section gutter (1px measurement tolerance); decorative track/spine excluded",
      observed: r4Observed,
      evidence: evidenceFor(timelineObservations),
    },
  ];
}

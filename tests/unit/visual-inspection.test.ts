import {
  BACKGROUND_SAMPLE_REGIONS,
  BACKGROUND_SAMPLE_POINTS,
  BACKGROUND_SAMPLE_TOPOLOGY,
  BACKGROUND_UNIFORMITY_TOLERANCE,
  computeViewportInsets,
  evaluateVisualConvergence,
  type BrowserChromeReview,
  type HeroCopySnapshot,
  type HeroObservation,
  type TimelineSemanticAnchor,
  type TimelineSemanticInspection,
  type TimelineSemanticRow,
  type VisualProbeObservation,
  type VisualScenarioObservation,
} from "../../src/motion/visual-inspection";
import { describe, expect, it } from "vitest";

const chromeReview: BrowserChromeReview = {
  expanded: { screenshot: "device-expanded.png", curtainVisible: false },
  collapsed: { screenshot: "device-collapsed.png", curtainVisible: false },
  reviewedAt: "2026-08-26T00:00:00.000Z",
};

function backgroundSamples(spread = 0) {
  const points = BACKGROUND_SAMPLE_POINTS.map(({ x, y }) => ({
    x: x * 390,
    y: y * 844,
  }));
  return {
    source: "rendered-first-screen" as const,
    owner: "#scrolly",
    topology: BACKGROUND_SAMPLE_TOPOLOGY,
    regions: [...BACKGROUND_SAMPLE_REGIONS],
    cssViewport: { width: 390, height: 844 },
    bitmap: { width: 780, height: 1688 },
    devicePixelRatio: 2,
    expectedCount: points.length,
    texture: "patch-averaged" as const,
    samples: points.map(({ x, y }, index) => ({
      region: BACKGROUND_SAMPLE_REGIONS[index],
      css: { x, y },
      bitmap: { x: Math.round(x * 2), y: Math.round(y * 2) },
      patch: { width: 16, height: 16 },
      rgba: {
        r: 20 + (index === points.length - 1 ? spread : 0),
        g: 30,
        b: 40,
        a: 255,
      },
      hitStack: ["#scrolly"],
      backgroundOnly: true,
    })),
  };
}

function copySnapshot(
  overrides: Partial<HeroCopySnapshot> = {},
): HeroCopySnapshot {
  const { rect: rectOverride, ...scalarOverrides } = overrides;
  return {
    text: "14+ years",
    display: "block",
    visibility: "visible",
    opacity: 1,
    viewportIntersection: true,
    unclipped: true,
    occluded: false,
    ...scalarOverrides,
    rect: { left: 80, top: 80, width: 180, height: 60, ...rectOverride },
  };
}

function semanticAnchor(
  kind: TimelineSemanticAnchor["kind"],
  id: string,
  label: string,
  left = 24,
  readable = true,
): TimelineSemanticAnchor {
  return {
    kind,
    id,
    label,
    left,
    visible: true,
    width: 100,
    height: 20,
    readable,
  };
}

function semanticRow(index: number, year = 24, body = 24): TimelineSemanticRow {
  return {
    id: `row-${index}`,
    year: semanticAnchor(
      "year",
      `row-${index}-year`,
      String(2018 + index),
      year,
    ),
    body: semanticAnchor("body", `row-${index}-body`, `Role ${index}`, body),
    readableBodyDescendants: [
      semanticAnchor(
        "body-descendant",
        `row-${index}-title`,
        `Role ${index} title`,
      ),
    ],
  };
}

function semanticTimeline(
  overrides: Partial<TimelineSemanticInspection> = {},
): TimelineSemanticInspection {
  return {
    complete: true,
    title: semanticAnchor("title", "timeline-title", "The journey"),
    header: semanticAnchor("header", "timeline-header", "Experience"),
    rowCount: 2,
    rows: [semanticRow(0), semanticRow(1)],
    ...overrides,
  };
}

type ProbeOverrides = {
  surfaces?: Partial<VisualProbeObservation["surfaces"]>;
  insets?: Partial<VisualProbeObservation["insets"]>;
};

type ObservationOptions = ProbeOverrides & {
  scenarioId?: string;
  evidence?: VisualScenarioObservation["evidence"];
  hero?: Partial<HeroObservation>;
  browserChrome?: BrowserChromeReview;
};

function observation(
  checkpoint: VisualScenarioObservation["checkpoint"],
  options: ObservationOptions = {},
): VisualScenarioObservation {
  const defaultPhase =
    checkpoint === "hero-role"
      ? "ready"
      : checkpoint === "hero-return"
        ? "released"
        : "complete";
  const defaultPersistence =
    checkpoint === "hero-return"
      ? [
          { ...copySnapshot(), delayMs: 0 },
          { ...copySnapshot(), delayMs: 500 },
          { ...copySnapshot(), delayMs: 2_000 },
        ]
      : undefined;
  return {
    scenarioId: options.scenarioId ?? "scenario-1",
    evidence: options.evidence ?? "synthetic-browser",
    checkpoint,
    browserChrome: options.browserChrome,
    hero: {
      phase: defaultPhase,
      targetFrame: 149,
      displayFrame: 149,
      experienceOpacity: 1,
      computedExperienceOpacity: 1,
      experience: copySnapshot(),
      persistenceSamples: defaultPersistence,
      ...options.hero,
    },
    probe: {
      viewport: {
        layoutWidth: 390,
        layoutHeight: 844,
        visualWidth: 390,
        visualHeight: 844,
        visualOffsetTop: 0,
        visualOffsetLeft: 0,
        visualScale: 1,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      surfaces: {
        html: "rgb(1, 2, 3)|none",
        body: "rgb(1, 2, 3)|none",
        scrolly: "rgb(1, 2, 3)|none",
        sticky: "rgb(1, 2, 3)|none",
        loader: "rgb(1, 2, 3)|none",
        canvasPixels: [],
        compositedPixels: [
          { r: 10, g: 20, b: 30, a: 255 },
          { r: 250, g: 250, b: 250, a: 255 },
        ],
        backgroundSamples: backgroundSamples(),
        noiseImage: "url(noise.png)",
        ...options.surfaces,
      },
      insets: {
        standardSectionGutter: 24,
        timelineHeader: 24,
        timelineTrack: 0,
        timelineFirstContent: 0,
        timelineSemantic: semanticTimeline(),
        ...options.insets,
      },
      document: { scrollX: 0, scrollY: 0, scrollWidth: 390, clientWidth: 390 },
    },
  };
}

function finding(
  values: readonly VisualScenarioObservation[],
  requirement: "R1" | "R2" | "R3" | "R4",
) {
  return evaluateVisualConvergence(values).find(
    (item) => item.requirement === requirement,
  )!;
}

function requiredCheckpoints(extra: readonly VisualScenarioObservation[] = []) {
  return [
    observation("hero-role"),
    observation("hero-experience"),
    observation("hero-terminal"),
    observation("hero-return"),
    observation("timeline"),
    ...extra,
  ];
}

function replaceCheckpoint(
  checkpoint: VisualScenarioObservation["checkpoint"],
  replacement: VisualScenarioObservation,
): VisualScenarioObservation[] {
  return [
    ...requiredCheckpoints().filter((value) => value.checkpoint !== checkpoint),
    replacement,
  ];
}

describe("visual inspection model", () => {
  it("derives browser-chrome gaps from the visual viewport", () => {
    expect(
      computeViewportInsets({
        innerWidth: 390,
        innerHeight: 844,
        visualWidth: 390,
        visualHeight: 760,
        offsetTop: 24,
        offsetLeft: 0,
      }),
    ).toEqual({ top: 24, right: 0, bottom: 60, left: 0 });
  });

  it("keys evidence by checkpoint and requires both reviewed real-device chrome states for R1", () => {
    const values = requiredCheckpoints([
      observation("hero-role", {
        evidence: "real-device",
        browserChrome: chromeReview,
      }),
    ]);
    expect(finding(values, "R1").status).toBe("met");

    const curtainVisible = {
      ...chromeReview,
      collapsed: { ...chromeReview.collapsed, curtainVisible: true },
    };
    expect(
      finding(
        requiredCheckpoints([
          observation("hero-role", {
            evidence: "real-device",
            browserChrome: curtainVisible,
          }),
        ]),
        "R1",
      ).status,
    ).toBe("unmet");

    expect(
      finding(
        requiredCheckpoints([
          observation("hero-role", {
            evidence: "real-device",
            browserChrome: { ...chromeReview, collapsed: undefined as never },
          }),
        ]),
        "R1",
      ).status,
    ).toBe("inconclusive");
  });

  it("does not let a synthetic duplicate overwrite a real-device R1 result", () => {
    const real = observation("hero-role", {
      evidence: "real-device",
      browserChrome: chromeReview,
    });
    const values = [
      real,
      observation("hero-role"),
      ...requiredCheckpoints().slice(1),
    ];
    expect(finding(values, "R1").status).toBe("met");
  });

  it("evaluates rendered first-screen samples, not intentional final-composite noise", () => {
    expect(finding(requiredCheckpoints(), "R2").status).toBe("met");
    expect(
      finding(
        requiredCheckpoints([
          observation("hero-role", {
            evidence: "real-device",
            browserChrome: chromeReview,
            surfaces: { backgroundSamples: undefined },
          }),
        ]),
        "R2",
      ).status,
    ).toBe("met");
    expect(
      finding(
        replaceCheckpoint(
          "hero-role",
          observation("hero-role", {
            surfaces: {
              backgroundSamples: backgroundSamples(
                BACKGROUND_UNIFORMITY_TOLERANCE + 1,
              ),
            },
          }),
        ),
        "R2",
      ).status,
    ).toBe("unmet");
  });

  it("does not treat duplicate synthetic R2 checkpoints as one capture", () => {
    const values = [...requiredCheckpoints(), observation("hero-role")];
    expect(finding(values, "R2").status).toBe("inconclusive");
  });

  it.each([
    ["missing", undefined],
    ["empty", { ...backgroundSamples(), expectedCount: 0, samples: [] }],
    [
      "wrong topology",
      { ...backgroundSamples(), topology: "unknown" as never },
    ],
    [
      "duplicate region",
      {
        ...backgroundSamples(),
        samples: backgroundSamples().samples.map((sample, index) => ({
          ...sample,
          region: index === 1 ? BACKGROUND_SAMPLE_REGIONS[0] : sample.region,
        })),
      },
    ],
    [
      "wrong owner",
      {
        ...backgroundSamples(),
        samples: backgroundSamples().samples.map((sample) => ({
          ...sample,
          hitStack: ["#foreground"],
        })),
      },
    ],
    [
      "foreground hit stack",
      {
        ...backgroundSamples(),
        samples: backgroundSamples().samples.map((sample) => ({
          ...sample,
          hitStack: ["#scrolly", "#st1"],
        })),
      },
    ],
    [
      "not background only",
      {
        ...backgroundSamples(),
        samples: backgroundSamples().samples.map((sample) => ({
          ...sample,
          backgroundOnly: false,
        })),
      },
    ],
    [
      "texture included",
      { ...backgroundSamples(), texture: "included" as const },
    ],
  ])(
    "marks %s background evidence inconclusive instead of passing",
    (_name, samples) => {
      expect(
        finding(
          requiredCheckpoints([
            {
              ...observation("hero-role"),
              probe: {
                ...observation("hero-role").probe,
                surfaces: {
                  ...observation("hero-role").probe.surfaces,
                  backgroundSamples: samples,
                },
              },
            },
          ]),
          "R2",
        ).status,
      ).toBe("inconclusive");
    },
  );

  it("requires semantic text and complete visibility evidence at terminal and return", () => {
    const values = requiredCheckpoints();
    expect(finding(values, "R3").status).toBe("met");

    const failureCases: Partial<HeroCopySnapshot>[] = [
      { text: "Designer" },
      { display: "none" },
      { visibility: "hidden" },
      { opacity: 0.94 },
      { rect: { left: 80, top: 80, width: 0, height: 60 } },
      { viewportIntersection: false },
      { unclipped: false },
      { occluded: true },
    ];
    for (const overrides of failureCases) {
      expect(
        finding(
          replaceCheckpoint(
            "hero-terminal",
            observation("hero-terminal", {
              hero: { experience: copySnapshot(overrides) },
            }),
          ),
          "R3",
        ).status,
      ).toBe("unmet");
    }
  });

  it("requires a complete terminal phase and the full delayed return schedule in one synthetic scenario", () => {
    expect(
      finding(
        replaceCheckpoint(
          "hero-terminal",
          observation("hero-terminal", { hero: { phase: "playing" } }),
        ),
        "R3",
      ).status,
    ).toBe("unmet");
    expect(
      finding(
        replaceCheckpoint(
          "hero-return",
          observation("hero-return", {
            hero: {
              persistenceSamples: [
                { ...copySnapshot(), delayMs: 0 },
                { ...copySnapshot(), delayMs: 500 },
              ],
            },
          }),
        ),
        "R3",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        replaceCheckpoint(
          "hero-return",
          observation("hero-return", {
            hero: {
              persistenceSamples: [
                { ...copySnapshot(), delayMs: 0 },
                { ...copySnapshot(), delayMs: 100 },
                { ...copySnapshot(), delayMs: 2_000 },
              ],
            },
          }),
        ),
        "R3",
      ).status,
    ).toBe("met");
    expect(
      finding(
        replaceCheckpoint(
          "hero-return",
          observation("hero-return", {
            hero: {
              persistenceSamples: [
                { ...copySnapshot(), delayMs: 0 },
                { ...copySnapshot(), delayMs: 500 },
                { ...copySnapshot(), delayMs: 1_999 },
              ],
            },
          }),
        ),
        "R3",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        [
          ...requiredCheckpoints().filter(
            (value) => value.checkpoint !== "hero-return",
          ),
          observation("hero-return", { scenarioId: "other-scenario" }),
        ],
        "R3",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        [
          ...requiredCheckpoints().filter(
            (value) => value.checkpoint !== "hero-return",
          ),
          observation("hero-return", { evidence: "real-device" }),
        ],
        "R3",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        [
          ...requiredCheckpoints().filter(
            (value) => value.checkpoint !== "hero-return",
          ),
          observation("hero-return"),
          observation("hero-return", { scenarioId: "other-scenario" }),
        ],
        "R3",
      ).status,
    ).toBe("inconclusive");
  });

  it("uses the minimum of exhaustive semantic timeline anchors and ignores decoration", () => {
    expect(finding(requiredCheckpoints(), "R4").status).toBe("met");
    const offender = semanticTimeline({
      rows: [semanticRow(0, 15), semanticRow(1)],
    });
    const result = finding(
      requiredCheckpoints([
        observation("timeline", {
          insets: { timelineTrack: 0, timelineSemantic: offender },
        }),
      ]),
      "R4",
    );
    expect(result.status).toBe("unmet");
    expect(result.observed).toContain("year:2018=15.0px");
  });

  it("accepts the one-pixel boundary but marks missing or incomplete semantic anchors inconclusive", () => {
    const boundary = semanticTimeline({
      header: semanticAnchor("header", "timeline-header", "Experience", 23),
      title: semanticAnchor("title", "timeline-title", "The journey", 23),
      rows: [semanticRow(0, 23, 23)],
      rowCount: 1,
    });
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", { insets: { timelineSemantic: boundary } }),
        ]),
        "R4",
      ).status,
    ).toBe("met");

    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: { timelineSemantic: { ...boundary, complete: false } },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: { timelineSemantic: { ...boundary, rows: [] } },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: { timelineSemantic: { ...boundary, title: null } },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: { timelineSemantic: { ...boundary, rowCount: 2 } },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: {
              timelineSemantic: {
                ...boundary,
                rows: [semanticRow(0, 24, 24), semanticRow(0, 24, 24)],
              },
            },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: {
              timelineSemantic: {
                ...boundary,
                rows: [{ ...semanticRow(0), readableBodyDescendants: [] }],
              },
            },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
    expect(
      finding(
        requiredCheckpoints([
          observation("timeline", {
            insets: {
              timelineSemantic: {
                ...boundary,
                rows: [
                  {
                    ...semanticRow(0),
                    body: { ...semanticRow(0).body, visible: false },
                  },
                ],
              },
            },
          }),
        ]),
        "R4",
      ).status,
    ).toBe("inconclusive");
  });
});

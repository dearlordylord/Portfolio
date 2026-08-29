import {
  BACKGROUND_SAMPLE_POINTS,
  type BackgroundSampleRegion,
  computeViewportInsets,
  type Rgba,
  type TimelineSemanticAnchor,
  type TimelineSemanticInspection,
  type TimelineSemanticRow,
  type VisualProbeObservation,
} from "../motion/visual-inspection";
import type { MotionDiagnosticsPort } from "./diagnostics";
import {
  heightRatio,
  horizontalGap,
  verticalOffset,
  type ObservedRect,
  type SpatialAnchor,
  type SpatialObservation,
} from "../motion/convergence-observation";

/**
 * A pixel sample is evidence only when the harness can explain where it came
 * from.  Plain colour arrays made it impossible to tell whether a sample hit
 * the canvas background, a photo, the noise layer, or an overlay.  Keep the
 * coordinates in both CSS and bitmap space so a screenshot can be audited by
 * somebody who was not present for the capture.
 */
export type VisualBackgroundSample = Readonly<{
  region: BackgroundSampleRegion;
  css: { x: number; y: number };
  bitmap: { x: number; y: number };
  patch: { width: number; height: number };
  rgba: Rgba;
  hitStack: readonly string[];
  backgroundOnly: boolean;
  reason: string;
}>;

export type VisualSemanticLeftEdge = Readonly<{
  selector: string;
  label: string;
  left: number;
  right: number;
  width: number;
  visible: boolean;
}>;

export type VisualElementEvidence = Readonly<{
  selector: string;
  text: string;
  display: string;
  visibility: string;
  opacity: number;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  viewportIntersection: {
    x: number;
    y: number;
    width: number;
    height: number;
    area: number;
  };
  clipIntersection: {
    x: number;
    y: number;
    width: number;
    height: number;
    area: number;
  };
  clipped: boolean;
  hitTestPoints: readonly {
    x: number;
    y: number;
    stack: readonly string[];
    containsTarget: boolean;
    occluded: boolean;
  }[];
  occluded: boolean;
}>;

/** Browser-side additions to the stable pure model. The pure evaluator owns
 * the final verdict; this adapter only records inspectable browser facts. */
export type BrowserVisualProbeObservation = VisualProbeObservation & {
  surfaces: VisualProbeObservation["surfaces"] & {
    /** Final-composite samples are context only and never feed R2. */
    compositedBackgroundSamples?: readonly VisualBackgroundSample[];
  };
  /** Full browser evidence used by the capture harness to build HeroCopySnapshot. */
  heroExperience: VisualElementEvidence;
  /** Verbose DOM geometry retained for the HTML report; the pure model uses
   * `insets.timelineSemantic` as its stable contract. */
  timelineLeftEdges: readonly VisualSemanticLeftEdge[];
  timelineWrapperGutter: number;
  /** Generic rendered anchors/relationships for the next convergence cycle. */
  spatial: SpatialObservation;
};

function observedRect(element: Element | null): ObservedRect | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
  };
}

function captureSpatialObservation(
  ownerWindow: Window,
  ownerDocument: Document,
): SpatialObservation {
  const selectors = {
    hero: "#scrolly",
    heroStage: "#scrolly-sticky",
    heroHead: "#scrolly-canvas",
    heroRoleCopy: "#st1",
    heroExperienceCopy: "#st2",
    aboutSurface: "#about",
    journeySpine: "#timeline .tl-spine",
  } as const;
  const anchors: Record<string, SpatialAnchor> = {};
  const anchor = (
    id: string,
    selector: string,
    element: Element | null,
  ): SpatialAnchor => {
    if (!element) {
      return {
        id,
        selector,
        present: false,
        rect: null,
        viewportIntersectionRatio: null,
        ancestorClipped: null,
        style: null,
      };
    }
    const box = element.getBoundingClientRect();
    const rect = observedRect(element)!;
    const computed = ownerWindow.getComputedStyle(element);
    const viewportVisible = intersectRect(
      rect.left,
      rect.top,
      rect.right,
      rect.bottom,
      viewportRect(ownerWindow),
    );
    let ancestorVisible = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      area: rect.width * rect.height,
    };
    let ancestor = element.parentElement;
    while (ancestor) {
      const ancestorStyle = ownerWindow.getComputedStyle(ancestor);
      if (
        isClippingOverflow(ancestorStyle.overflowX) ||
        isClippingOverflow(ancestorStyle.overflowY)
      ) {
        const ancestorBox = ancestor.getBoundingClientRect();
        ancestorVisible = intersectRect(
          ancestorVisible.x,
          ancestorVisible.y,
          ancestorVisible.x + ancestorVisible.width,
          ancestorVisible.y + ancestorVisible.height,
          ancestorBox,
        );
      }
      ancestor = ancestor.parentElement;
    }
    const area = box.width * box.height;
    return {
      id,
      selector,
      present: true,
      rect,
      viewportIntersectionRatio: area > 0 ? viewportVisible.area / area : 0,
      ancestorClipped: ancestorVisible.area + 0.5 < Math.max(0, area),
      style: {
        borderTopLeftRadius: computed.borderTopLeftRadius,
        borderTopRightRadius: computed.borderTopRightRadius,
        borderBottomRightRadius: computed.borderBottomRightRadius,
        borderBottomLeftRadius: computed.borderBottomLeftRadius,
        overflowX: computed.overflowX,
        overflowY: computed.overflowY,
      },
    };
  };
  for (const [id, selector] of Object.entries(selectors)) {
    const element = ownerDocument.querySelector(selector);
    anchors[id] = anchor(id, selector, element);
  }
  ownerDocument.querySelectorAll("#timeline .tl-row").forEach((row, index) => {
    for (const [suffix, selector] of [
      ["Year", ".tl-yr"],
      ["Body", ".tl-body"],
      ["BodyContent", ".tl-body > *"],
    ] as const) {
      const id = `journeyRow${index}${suffix}`;
      const element = row.querySelector(selector);
      const fullSelector = `#timeline .tl-row:nth-child(${index + 2}) ${selector}`;
      anchors[id] = anchor(id, fullSelector, element);
    }
  });
  const relation = (
    id: string,
    kind: "height-ratio" | "vertical-offset" | "horizontal-gap",
    from: string,
    to: string,
    value: number | null,
  ) => ({
    id,
    kind,
    from,
    to,
    value,
    unit: kind === "height-ratio" ? ("ratio" as const) : ("css-px" as const),
  });
  const relations = [
    relation(
      "hero-head-to-stage-height",
      "height-ratio",
      "heroHead",
      "heroStage",
      heightRatio(anchors.heroHead!.rect, anchors.heroStage!.rect),
    ),
    relation(
      "role-copy-top-from-stage",
      "vertical-offset",
      "heroRoleCopy",
      "heroStage",
      verticalOffset(anchors.heroRoleCopy!.rect, anchors.heroStage!.rect),
    ),
    relation(
      "experience-copy-top-from-stage",
      "vertical-offset",
      "heroExperienceCopy",
      "heroStage",
      verticalOffset(anchors.heroExperienceCopy!.rect, anchors.heroStage!.rect),
    ),
  ];
  ownerDocument.querySelectorAll("#timeline .tl-row").forEach((_, index) => {
    const yearId = `journeyRow${index}Year`;
    const bodyId = `journeyRow${index}BodyContent`;
    relations.push(
      relation(
        `journey-row-${index}-year-to-spine`,
        "horizontal-gap",
        yearId,
        "journeySpine",
        horizontalGap(anchors[yearId]?.rect ?? null, anchors.journeySpine!.rect),
      ),
      relation(
        `journey-row-${index}-spine-to-body`,
        "horizontal-gap",
        "journeySpine",
        bodyId,
        horizontalGap(anchors.journeySpine!.rect, anchors[bodyId]?.rect ?? null),
      ),
    );
  });
  return {
    anchors,
    relations,
  };
}

function leftOf(ownerDocument: Document, selector: string): number {
  return (
    ownerDocument.querySelector(selector)?.getBoundingClientRect().left ??
    Number.NaN
  );
}

function surface(
  ownerWindow: Window,
  ownerDocument: Document,
  selector: string,
): string {
  const element = ownerDocument.querySelector(selector);
  if (!element) return "missing";
  const style = ownerWindow.getComputedStyle(element);
  return `${style.backgroundColor}|${style.backgroundImage}`;
}

function averagePatch(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): Rgba {
  const data = context.getImageData(x, y, width, height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const count = Math.max(1, data.length / 4);
  for (let index = 0; index < data.length; index += 4) {
    r += data[index] ?? 0;
    g += data[index + 1] ?? 0;
    b += data[index + 2] ?? 0;
    a += data[index + 3] ?? 0;
  }
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: Math.round(a / count),
  };
}

function elementName(element: Element): string {
  return element.id
    ? `#${element.id}`
    : element.classList.length > 0
      ? `${element.tagName.toLowerCase()}.${Array.from(element.classList).slice(0, 2).join(".")}`
      : element.tagName.toLowerCase();
}

function stackAt(ownerDocument: Document, x: number, y: number): string[] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return [];
  return typeof ownerDocument.elementsFromPoint === "function"
    ? ownerDocument.elementsFromPoint(x, y).map(elementName)
    : [];
}

function rectObject(box: DOMRect): VisualElementEvidence["rect"] {
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    left: box.left,
  };
}

function intersectRect(
  left: number,
  top: number,
  right: number,
  bottom: number,
  other: { left: number; top: number; right: number; bottom: number },
): { x: number; y: number; width: number; height: number; area: number } {
  const nextLeft = Math.max(left, other.left);
  const nextTop = Math.max(top, other.top);
  const nextRight = Math.min(right, other.right);
  const nextBottom = Math.min(bottom, other.bottom);
  const width = Math.max(0, nextRight - nextLeft);
  const height = Math.max(0, nextBottom - nextTop);
  return { x: nextLeft, y: nextTop, width, height, area: width * height };
}

function isClippingOverflow(value: string): boolean {
  return (
    value === "hidden" ||
    value === "clip" ||
    value === "scroll" ||
    value === "auto"
  );
}

function viewportRect(ownerWindow: Window): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const visual = ownerWindow.visualViewport;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return {
    left,
    top,
    right: left + (visual?.width ?? ownerWindow.innerWidth),
    bottom: top + (visual?.height ?? ownerWindow.innerHeight),
  };
}

function captureHitTestPoints(
  ownerDocument: Document,
  element: HTMLElement,
  box: DOMRect,
): VisualElementEvidence["hitTestPoints"] {
  if (box.width <= 0 || box.height <= 0) return [];
  // Three points are intentional: a centered point can fall in a line gap or
  // in a transparent glyph.  We retain the hit stack for human inspection,
  // while `occluded` is based on an opaque higher layer because the hero copy
  // itself uses pointer-events:none.
  const points = [0.2, 0.5, 0.8].map((ratio) => ({
    x: box.left + box.width * 0.5,
    y: box.top + box.height * ratio,
  }));
  // Hero copy is intentionally pointer-events:none. Temporarily making the
  // target hit-testable lets the browser provide an actual paint-order stack
  // instead of making occlusion a z-index guess. The inline value is restored
  // before the probe returns, so diagnostics never alter page behavior.
  const originalPointerEvents = element.style.pointerEvents;
  element.style.pointerEvents = "auto";
  try {
    return points.map(({ x, y }) => {
      const elements =
        typeof ownerDocument.elementsFromPoint === "function"
          ? ownerDocument.elementsFromPoint(x, y)
          : [];
      const stack = elements.map(elementName);
      const targetIndex = elements.findIndex(
        (candidate) => candidate === element || element.contains(candidate),
      );
      return {
        x,
        y,
        stack,
        containsTarget: targetIndex >= 0,
        occluded: targetIndex > 0,
      };
    });
  } finally {
    element.style.pointerEvents = originalPointerEvents;
  }
}

function captureElementEvidence(
  ownerWindow: Window,
  ownerDocument: Document,
  selector: string,
): VisualElementEvidence {
  const element = ownerDocument.querySelector(selector) as HTMLElement | null;
  if (!element) {
    return {
      selector,
      text: "",
      display: "missing",
      visibility: "missing",
      opacity: 0,
      rect: {
        x: Number.NaN,
        y: Number.NaN,
        width: 0,
        height: 0,
        top: Number.NaN,
        right: Number.NaN,
        bottom: Number.NaN,
        left: Number.NaN,
      },
      viewportIntersection: { x: 0, y: 0, width: 0, height: 0, area: 0 },
      clipIntersection: { x: 0, y: 0, width: 0, height: 0, area: 0 },
      clipped: true,
      hitTestPoints: [],
      occluded: true,
    };
  }
  const style = ownerWindow.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const viewport = viewportRect(ownerWindow);
  let clipped = intersectRect(
    box.left,
    box.top,
    box.right,
    box.bottom,
    viewport,
  );
  let ancestor = element.parentElement;
  while (ancestor) {
    const ancestorStyle = ownerWindow.getComputedStyle(ancestor);
    if (
      isClippingOverflow(ancestorStyle.overflowX) ||
      isClippingOverflow(ancestorStyle.overflowY)
    ) {
      const ancestorBox = ancestor.getBoundingClientRect();
      clipped = intersectRect(
        clipped.x,
        clipped.y,
        clipped.x + clipped.width,
        clipped.y + clipped.height,
        ancestorBox,
      );
    }
    ancestor = ancestor.parentElement;
  }
  const opacity = Number.parseFloat(style.opacity || "0");
  const hitTestPoints = captureHitTestPoints(ownerDocument, element, box);
  return {
    selector,
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    display: style.display,
    visibility: style.visibility,
    opacity: Number.isFinite(opacity) ? opacity : 0,
    rect: rectObject(box),
    viewportIntersection: intersectRect(
      box.left,
      box.top,
      box.right,
      box.bottom,
      viewport,
    ),
    clipIntersection: clipped,
    clipped: clipped.area + 0.5 < Math.max(0, box.width * box.height),
    hitTestPoints,
    occluded: hitTestPoints.some((point) => point.occluded),
  };
}

function semanticLabel(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function captureTimelineLeftEdges(
  ownerDocument: Document,
  ownerWindow: Window,
): VisualSemanticLeftEdge[] {
  const edges: VisualSemanticLeftEdge[] = [];
  const add = (selector: string, element: Element): void => {
    const box = element.getBoundingClientRect();
    const style = ownerWindow.getComputedStyle(element);
    const width = Math.max(0, box.width);
    edges.push({
      selector,
      label: semanticLabel(element),
      left: box.left,
      right: box.right,
      width,
      visible:
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        width > 0 &&
        box.height > 0,
    });
  };
  const section = ownerDocument.querySelector("#timeline");
  if (!section) return edges;
  section
    .querySelectorAll(".stag, .stitle")
    .forEach((element) =>
      add(
        `#timeline .${element.classList.contains("stag") ? "stag" : "stitle"}`,
        element,
      ),
    );
  section.querySelectorAll(".tl-row").forEach((row, rowIndex) => {
    const year = row.querySelector(".tl-yr");
    const body = row.querySelector(".tl-body");
    if (year) add(`#timeline .tl-row[${rowIndex}] .tl-yr`, year);
    if (!body) return;
    add(`#timeline .tl-row[${rowIndex}] .tl-body`, body);
    body
      .querySelectorAll(":scope > *")
      .forEach((element, childIndex) =>
        add(
          `#timeline .tl-row[${rowIndex}] .tl-body > *[${childIndex}]`,
          element,
        ),
      );
  });
  return edges;
}

function captureTimelineSemantic(
  ownerDocument: Document,
  ownerWindow: Window,
): TimelineSemanticInspection {
  const section = ownerDocument.querySelector("#timeline");
  const headerElement = section?.querySelector(".stag") ?? null;
  const titleElement = section?.querySelector(".stitle") ?? null;
  const visible = (element: Element | null | undefined): element is Element => {
    if (!element) return false;
    const style = ownerWindow.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0 &&
      box.width > 0 &&
      box.height > 0 &&
      semanticLabel(element).length > 0
    );
  };
  const rows = Array.from(section?.querySelectorAll(".tl-row") ?? []);
  const anchor = (
    element: Element | null | undefined,
    kind: TimelineSemanticAnchor["kind"],
    id: string,
  ): TimelineSemanticAnchor | null => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const style = ownerWindow.getComputedStyle(element);
    const label = semanticLabel(element);
    return {
      kind,
      id,
      label,
      left: box.left,
      visible: visible(element),
      width: box.width,
      height: box.height,
      readable:
        visible(element) && style.visibility !== "hidden" && label.length > 0,
    };
  };
  const missingAnchor = (
    kind: TimelineSemanticAnchor["kind"],
    id: string,
  ): TimelineSemanticAnchor => ({
    kind,
    id,
    label: "",
    left: Number.NaN,
    visible: false,
    width: 0,
    height: 0,
    readable: false,
  });
  const header = anchor(headerElement, "header", "timeline-header");
  const title = anchor(titleElement, "title", "timeline-title");
  const rowRecords: TimelineSemanticRow[] = rows.map((row, rowIndex) => {
    const year = anchor(
      row.querySelector(".tl-yr"),
      "year",
      `timeline-row-${rowIndex}-year`,
    );
    const bodyElement = row.querySelector(".tl-body");
    const body = anchor(bodyElement, "body", `timeline-row-${rowIndex}-body`);
    const readableBodyDescendants = Array.from(
      bodyElement?.querySelectorAll(":scope > *") ?? [],
    )
      .map((element, childIndex) =>
        anchor(
          element,
          "body-descendant",
          `timeline-row-${rowIndex}-body-${childIndex}`,
        ),
      )
      .filter(
        (value): value is TimelineSemanticAnchor =>
          value !== null && value.visible && value.readable,
      );
    return {
      id: `timeline-row-${rowIndex}`,
      year: year ?? missingAnchor("year", `timeline-row-${rowIndex}-year`),
      body: body ?? missingAnchor("body", `timeline-row-${rowIndex}-body`),
      readableBodyDescendants,
    };
  });
  const complete = Boolean(
    section &&
    header &&
    title &&
    header.visible &&
    title.visible &&
    header.readable &&
    title.readable &&
    rowRecords.length > 0 &&
    rowRecords.every(
      (row) =>
        row.year.visible &&
        row.year.readable &&
        row.body.visible &&
        row.body.readable &&
        row.readableBodyDescendants.length > 0,
    ),
  );
  return { complete, header, title, rowCount: rows.length, rows: rowRecords };
}

function sampleCanvas(
  ownerWindow: Window,
  ownerDocument: Document,
): VisualBackgroundSample[] {
  const canvas = ownerDocument.getElementById(
    "scrolly-canvas",
  ) as HTMLCanvasElement | null;
  const context = canvas?.getContext("2d");
  if (!canvas || !context || canvas.width < 1 || canvas.height < 1) return [];
  const box = canvas.getBoundingClientRect();
  const foregroundSelectors = [
    "#st1",
    "#st2",
    "#st-reduced",
    "#explore-cta",
    "#photo-strip",
    "#scroll-hint",
    "nav",
  ];
  return BACKGROUND_SAMPLE_POINTS.map(({ region, x, y }) => {
    const bitmapX = Math.min(
      canvas.width - 1,
      Math.max(0, Math.round(canvas.width * x)),
    );
    const bitmapY = Math.min(
      canvas.height - 1,
      Math.max(0, Math.round(canvas.height * y)),
    );
    const patchWidth = Math.min(24, canvas.width);
    const patchHeight = Math.min(24, canvas.height);
    const patchX = Math.min(
      canvas.width - patchWidth,
      Math.max(0, bitmapX - Math.floor(patchWidth / 2)),
    );
    const patchY = Math.min(
      canvas.height - patchHeight,
      Math.max(0, bitmapY - Math.floor(patchHeight / 2)),
    );
    // CSS coordinates are local to the owned canvas. This makes the mapping
    // auditable against the bitmap even when the canvas is staged below the
    // copy slot in the viewport.
    const cssX = box.width * x;
    const cssY = box.height * y;
    const hitStack = stackAt(ownerDocument, box.left + cssX, box.top + cssY);
    const hitElements =
      typeof ownerDocument.elementsFromPoint === "function"
        ? ownerDocument.elementsFromPoint(box.left + cssX, box.top + cssY)
        : [];
    const backgroundOnly =
      hitElements.length > 0 &&
      !foregroundSelectors.some((selector) =>
        hitElements.some(
          (element) =>
            element.matches(selector) || Boolean(element.closest(selector)),
        ),
      );
    return {
      region,
      css: { x: cssX, y: cssY },
      bitmap: { x: bitmapX, y: bitmapY },
      patch: { width: patchWidth, height: patchHeight },
      rgba: averagePatch(context, patchX, patchY, patchWidth, patchHeight),
      hitStack,
      backgroundOnly,
      reason: backgroundOnly
        ? "sample point is outside known DOM foreground layers"
        : "sample point intersects a known DOM foreground layer",
    };
  });
}

export function captureVisualProbe(
  ownerWindow: Window,
  ownerDocument: Document,
  includeBackgroundSamples = true,
): VisualProbeObservation {
  const visual = ownerWindow.visualViewport;
  const visualWidth = visual?.width ?? ownerWindow.innerWidth;
  const visualHeight = visual?.height ?? ownerWindow.innerHeight;
  const offsetTop = visual?.offsetTop ?? 0;
  const offsetLeft = visual?.offsetLeft ?? 0;
  const standardWrapper = ownerDocument.querySelector("#about .sw");
  const timelineWrapper = ownerDocument.querySelector("#timeline .tl-sw");
  const aboutGutter = standardWrapper
    ? standardWrapper.getBoundingClientRect().left +
      Number.parseFloat(
        ownerWindow.getComputedStyle(standardWrapper).paddingLeft || "0",
      )
    : Number.NaN;
  const timelineWrapperGutter = timelineWrapper
    ? timelineWrapper.getBoundingClientRect().left +
      Number.parseFloat(
        ownerWindow.getComputedStyle(timelineWrapper).paddingLeft || "0",
      )
    : Number.NaN;
  // R4 is a local contract: compare timeline content with its own wrapper,
  // not with an unrelated section whose max-width may differ on desktop.
  const standardSectionGutter = Number.isFinite(timelineWrapperGutter)
    ? timelineWrapperGutter
    : aboutGutter;
  const canvasSamples = includeBackgroundSamples
    ? sampleCanvas(ownerWindow, ownerDocument)
    : [];
  const timelineLeftEdges = captureTimelineLeftEdges(
    ownerDocument,
    ownerWindow,
  );
  const timelineSemantic = captureTimelineSemantic(ownerDocument, ownerWindow);
  const heroExperience = captureElementEvidence(
    ownerWindow,
    ownerDocument,
    "#st2",
  );
  const probe: BrowserVisualProbeObservation = {
    viewport: {
      layoutWidth: ownerWindow.innerWidth,
      layoutHeight: ownerWindow.innerHeight,
      visualWidth,
      visualHeight,
      visualOffsetTop: offsetTop,
      visualOffsetLeft: offsetLeft,
      visualScale: visual?.scale ?? 1,
      insets: computeViewportInsets({
        innerWidth: ownerWindow.innerWidth,
        innerHeight: ownerWindow.innerHeight,
        visualWidth,
        visualHeight,
        offsetTop,
        offsetLeft,
      }),
    },
    surfaces: {
      html: surface(ownerWindow, ownerDocument, "html"),
      body: surface(ownerWindow, ownerDocument, "body"),
      scrolly: surface(ownerWindow, ownerDocument, "#scrolly"),
      sticky: surface(ownerWindow, ownerDocument, "#scrolly-sticky"),
      loader: surface(ownerWindow, ownerDocument, "#scrolly-loader"),
      // Legacy arrays remain populated for consumers that only need a quick
      // colour read.  The structured arrays below are the contract evidence.
      canvasPixels: canvasSamples.map((sample) => sample.rgba),
      compositedPixels: [],
      // The browser adapter cannot identify the final rendered owner without
      // a screenshot mask. The Playwright harness supplies that evidence;
      // leaving this absent prevents a canvas pixel from becoming an R2 pass.
      noiseImage: ownerWindow.getComputedStyle(
        ownerDocument.getElementById("noise-top")!,
      ).backgroundImage,
      compositedBackgroundSamples: [],
    },
    insets: {
      standardSectionGutter,
      timelineHeader: leftOf(ownerDocument, "#timeline .stag"),
      timelineTrack: leftOf(ownerDocument, "#timeline .tl-track"),
      timelineFirstContent: leftOf(ownerDocument, "#timeline .tl-body"),
      timelineSemantic,
    },
    document: {
      scrollX: ownerWindow.scrollX,
      scrollY: ownerWindow.scrollY,
      scrollWidth: ownerDocument.documentElement.scrollWidth,
      clientWidth: ownerDocument.documentElement.clientWidth,
    },
    heroExperience,
    timelineLeftEdges,
    timelineWrapperGutter,
    spatial: captureSpatialObservation(ownerWindow, ownerDocument),
  };
  return probe;
}

export function registerVisualInspection(
  diagnostics: MotionDiagnosticsPort | undefined,
  ownerWindow: Window = window,
  ownerDocument: Document = document,
): () => void {
  if (!diagnostics) return () => undefined;
  const inspectionWindow = ownerWindow as Window & {
    __portfolioVisualProbe?: () => VisualProbeObservation;
  };
  let latest = captureVisualProbe(ownerWindow, ownerDocument, false);
  diagnostics.register("visual", () => latest);
  inspectionWindow.__portfolioVisualProbe = () => {
    latest = captureVisualProbe(ownerWindow, ownerDocument, true);
    return latest;
  };
  return () => {
    diagnostics.unregister("visual");
    delete inspectionWindow.__portfolioVisualProbe;
  };
}

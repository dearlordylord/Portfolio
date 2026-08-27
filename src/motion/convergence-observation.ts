/**
 * Reusable evidence records for motion/layout convergence.
 *
 * These types describe browser facts, not desired CSS or scene internals. The
 * browser adapter and Playwright can therefore record the same vocabulary
 * before and after a fix without the measurement changing with the fix.
 */

export type ObservedRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

export type SpatialAnchor = Readonly<{
  id: string;
  selector: string;
  present: boolean;
  rect: ObservedRect | null;
  viewportIntersectionRatio: number | null;
  ancestorClipped: boolean | null;
  style: Readonly<{
    borderTopLeftRadius: string;
    borderTopRightRadius: string;
    borderBottomRightRadius: string;
    borderBottomLeftRadius: string;
    overflowX: string;
    overflowY: string;
  }> | null;
}>;

export type SpatialRelationKind =
  | "height-ratio"
  | "vertical-offset"
  | "horizontal-gap";

export type SpatialRelation = Readonly<{
  id: string;
  kind: SpatialRelationKind;
  from: string;
  to: string;
  value: number | null;
  unit: "ratio" | "css-px";
}>;

export type SpatialObservation = Readonly<{
  anchors: Readonly<Record<string, SpatialAnchor>>;
  relations: readonly SpatialRelation[];
}>;

export type TemporalInput = Readonly<{
  kind: "wheel" | "touch";
  trusted: boolean;
  deltaY: number;
  defaultPrevented: boolean | null;
}>;

export type TemporalSample = Readonly<{
  step: number;
  elapsedMs: number;
  input: TemporalInput | null;
  hero: Readonly<{
    phase: string;
    playbackCompleted: boolean;
    targetFrame: number;
    displayFrame: number;
    renderedFrame: number;
    progress: number;
  }>;
  document: Readonly<{
    scrollX: number;
    scrollY: number;
    /** Calls observed by the test-side wrapper; distinguishes known script motion. */
    programmaticScrollCalls: number;
  }>;
  visualViewport: Readonly<{
    width: number;
    height: number;
    offsetTop: number;
    offsetLeft: number;
  }>;
}>;

export type TemporalTrace = Readonly<{
  clock: "playwright-paused" | "real-device";
  samples: readonly TemporalSample[];
}>;

export type TemporalCharacterization = Readonly<{
  valid: boolean;
  firstProgressStep: number | null;
  firstDocumentScrollStep: number | null;
  firstInputDrivenScrollStep: number | null;
  firstProgrammaticScrollStep: number | null;
  firstTrustedInputStep: number | null;
  scrollBeforeHalfProgress: boolean | null;
}>;

/** Characterizes current behavior; it deliberately does not encode a target. */
export function characterizeTemporalTrace(
  trace: TemporalTrace,
): TemporalCharacterization {
  const ordered = trace.samples.every(
    (sample, index) =>
      sample.step === index &&
      Number.isFinite(sample.elapsedMs) &&
      (index === 0 || sample.elapsedMs >= trace.samples[index - 1]!.elapsedMs),
  );
  const finite = trace.samples.every(
    (sample) =>
      Number.isFinite(sample.hero.progress) &&
      sample.hero.progress >= 0 &&
      sample.hero.progress <= 1 &&
      [
        sample.hero.targetFrame,
        sample.hero.displayFrame,
        sample.hero.renderedFrame,
        sample.document.scrollX,
        sample.document.scrollY,
        sample.document.programmaticScrollCalls,
        sample.visualViewport.width,
        sample.visualViewport.height,
        sample.visualViewport.offsetTop,
        sample.visualViewport.offsetLeft,
        sample.input?.deltaY ?? 0,
      ].every(Number.isFinite) &&
      sample.document.programmaticScrollCalls >= 0 &&
      sample.visualViewport.width > 0 &&
      sample.visualViewport.height > 0,
  );
  const first = trace.samples[0];
  const firstProgress = trace.samples.find(
    (sample) => sample.hero.progress > (first?.hero.progress ?? 0),
  );
  const firstScroll = trace.samples.find(
    (sample) => sample.document.scrollY !== (first?.document.scrollY ?? 0),
  );
  const firstInputDrivenScroll = trace.samples.find((sample, index) => {
    const previous = trace.samples[index - 1];
    const initialProgrammaticCalls = first?.document.programmaticScrollCalls ?? 0;
    return Boolean(
      previous &&
      sample.document.scrollY !== previous.document.scrollY &&
      sample.document.programmaticScrollCalls === initialProgrammaticCalls &&
      previous.document.programmaticScrollCalls === initialProgrammaticCalls &&
      sample.input?.trusted,
    );
  });
  const firstProgrammaticScroll = trace.samples.find((sample, index) => {
    const previous = trace.samples[index - 1];
    return Boolean(previous && sample.document.programmaticScrollCalls > previous.document.programmaticScrollCalls);
  });
  const firstTrusted = trace.samples.find((sample) => sample.input?.trusted);
  return {
    valid: trace.samples.length >= 2 && ordered && finite,
    firstProgressStep: firstProgress?.step ?? null,
    firstDocumentScrollStep: firstScroll?.step ?? null,
    firstInputDrivenScrollStep: firstInputDrivenScroll?.step ?? null,
    firstProgrammaticScrollStep: firstProgrammaticScroll?.step ?? null,
    firstTrustedInputStep: firstTrusted?.step ?? null,
    scrollBeforeHalfProgress:
      firstScroll === undefined
        ? null
        : firstScroll.hero.progress < 0.5,
  };
}

export function horizontalGap(
  left: ObservedRect | null,
  right: ObservedRect | null,
): number | null {
  return left && right ? right.left - left.right : null;
}

export function heightRatio(
  part: ObservedRect | null,
  whole: ObservedRect | null,
): number | null {
  return part && whole && whole.height > 0 ? part.height / whole.height : null;
}

export function verticalOffset(
  element: ObservedRect | null,
  reference: ObservedRect | null,
): number | null {
  return element && reference ? element.top - reference.top : null;
}

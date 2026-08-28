import {
  HERO_CONTRACT,
  HERO_LAYOUT_CONTRACT,
  MOBILE_HERO_CONTRACT,
  computeMobileHeroAssetPlacement,
  mobileHeroDownwardScrollDisposition,
  computeHeroLayout,
  sampleHeroCTA,
  sampleHeroTimeline,
  sampleMobileHeroPresentation,
  smoothHeroFrame,
  transitionHeroPhase,
  type HeroPhase,
} from "../motion/hero-contract";
import { hasTransparentProbePixel } from "../motion/packed-alpha";
import {
  AssetReadinessRegistry,
  type AssetReadinessDiagnostics,
  type IntroReadinessPolicy,
} from "../motion/asset-fallback";
import {
  MotionScheduler,
  type MotionSchedulerScene,
} from "../motion/scheduler";
import { BoundedFrameCache, prefetchFrames } from "../motion/sequence-cache";
import {
  fallbackProductionHeroRenderer,
  HEVC_ALPHA_PRODUCTION_ASSET,
  HERO_NATIVE_CONTENT_HEIGHT,
  HERO_NATIVE_CONTENT_WIDTH,
  HERO_HEVC_ALPHA_MIME,
  HERO_NATIVE_END_FRAME,
  HERO_NATIVE_PREPARATION_DEADLINE_MS,
  HERO_VP9_ALPHA_MIME,
  isAppleSafariProfile,
  isProductionHevcAlphaQualified,
  nativeCandidateCanExpose,
  nativeFrameFromSeconds,
  nativeFrameToSeconds,
  nativeIntroPlaybackRate,
  nativeMainPlaybackRate,
  selectProductionHeroRenderer,
  type ProductionHeroRenderer,
  type ProductionHeroRendererPreference,
} from "../motion/hero-renderer";

const HERO_BREAKPOINT = HERO_LAYOUT_CONTRACT.breakpoint;
const HERO_DRIFT_FRAMES = HERO_CONTRACT.driftFrames;
const HERO_EXIT_HOLD_MS = HERO_CONTRACT.exitHoldDurationMs;
const DEFAULT_IMAGE_PREFIX = "Кадры/frame_";
const DEFAULT_IMAGE_SUFFIX = "_delay-0.067s.webp";
const DEFAULT_NOISE_SOURCE = "Кадры/ШУМ.png";
const DEFAULT_HERO_BACKGROUND = "#edeef6";
const MAX_DIAGNOSTIC_EVENTS = 128;
// Keep the first-screen request burst bounded. Intro frames are intentionally
// loaded before any later frame; after the semantic intro handoff, later
// frames are drained in a smaller queue so Safari is not asked to decode all
// 150 images during first paint.
/**
 * C keeps the complete 32-frame intro available so the first semantic
 * transition never has to re-decode an early frame. Once the main timeline
 * starts, the same fixed cache is reused for the current frame neighborhood.
 * At 900×507 RGBA this is roughly 58 MiB of decoded pixels, independent of
 * the 150-frame sequence length.
 */
export const HERO_C_FRAME_CACHE_CAPACITY = HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame + 1;
/** Number of frames kept around a moving C target for nearest-ready fallback. */
export const HERO_C_PREFETCH_RADIUS = 3;
/** Maximum simultaneous image decodes after the intro gate. */
export const HERO_C_LOAD_CONCURRENCY = 4;
/** Maximum simultaneous image decodes while the intro gate is being filled. */
export const HERO_C_INTRO_LOAD_CONCURRENCY = 8;
/** Absolute resident + in-flight upper bound for C's decoded image resources. */
export const HERO_C_MAX_DECODED_RESOURCES = HERO_C_FRAME_CACHE_CAPACITY + HERO_C_INTRO_LOAD_CONCURRENCY;
// A browser that cannot deliver either load/error (or leaves every image
// unusable) must not keep the page's native input captive indefinitely.
const HERO_READINESS_TIMEOUT_MS = 3_000;
const HERO_NATIVE_H_SOURCE = HEVC_ALPHA_PRODUCTION_ASSET.sourceUrl;
const HERO_NATIVE_A_SOURCE = "/video-prototype/hero-alpha-vp9.webm";
const HERO_NATIVE_H_ASSET_ID = HEVC_ALPHA_PRODUCTION_ASSET.assetId;
const HERO_NATIVE_H_SHA256 = HEVC_ALPHA_PRODUCTION_ASSET.sha256;

/**
 * The C handoff may use a nearby decoded source frame, but never a distant
 * one. Three frames is 200ms at the source's 15fps and is small enough to be
 * visually imperceptible while still allowing a bounded request neighborhood
 * to complete on a slow mobile decoder.
 */
export const HERO_NATIVE_FALLBACK_FRAME_TOLERANCE = 3;

export type MobileHeroInputDispositionInput = Readonly<{
  mobile: boolean;
  phase: HeroPhase;
  targetFrame: number;
  reducedMotion?: boolean;
  /** Native H/A is hidden behind the poster during this bounded window. */
  nativePreparationPending?: boolean;
  /** C is loading and owns the input until its watchdog fails open. */
  readinessWatchdogPending?: boolean;
  hasRenderableFrame?: boolean;
}>;

/**
 * Pure input policy used by both wheel and touch adapters. Native preparation
 * has its own four-second deadline, so it must participate in the same mobile
 * input lock as C readiness; otherwise a first gesture can scroll the page
 * while the candidate is still being qualified. Once either deadline expires,
 * the caller's C/readiness path takes over and can release input normally.
 */
export function mobileHeroInputDisposition(
  input: MobileHeroInputDispositionInput,
): "consume" | "native-next-gesture" {
  if (!input.mobile || input.reducedMotion === true) return "native-next-gesture";
  if (input.nativePreparationPending === true) return "consume";
  if (
    input.readinessWatchdogPending !== true &&
    !(input.phase !== "loading" && input.hasRenderableFrame === true)
  ) {
    return "native-next-gesture";
  }
  return mobileHeroDownwardScrollDisposition({
    phase: input.phase,
    targetFrame: input.targetFrame,
    reducedMotion: input.reducedMotion,
  });
}

export type NativeFallbackHandoffInput = Readonly<{
  targetFrame: number;
  renderedFrame: number | null;
  /** True only after the candidate C image passed its load/dimension gate. */
  decoded: boolean;
  toleranceFrames?: number;
}>;

/**
 * Pure commit gate for a late native→C handoff. The DOM adapter keeps the
 * native surface mounted until this returns true, then swaps surfaces in one
 * task. Keeping the tolerance here makes the visual convergence criterion
 * inspectable without a browser.
 */
export function shouldCommitNativeFallbackHandoff(
  input: NativeFallbackHandoffInput,
): boolean {
  const tolerance = input.toleranceFrames ?? HERO_NATIVE_FALLBACK_FRAME_TOLERANCE;
  if (!Number.isFinite(input.targetFrame) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("Native fallback handoff frames must be finite");
  }
  return input.decoded === true
    && input.renderedFrame !== null
    && Number.isFinite(input.renderedFrame)
    && Math.abs(input.renderedFrame - input.targetFrame) <= tolerance;
}

type HeroElementId =
  | "scrolly"
  | "scrolly-canvas"
  | "scrolly-loader"
  | "loader-fill"
  | "photo-strip"
  | "st1"
  | "st2"
  | "noise-top"
  | "explore-cta"
  | "scroll-hint"
  | "hero-native-stage";

export type HeroDiagnosticsPort = {
  register(name: string, reader: () => unknown): void;
  unregister?(name: string): void;
};

type HeroImageFactory = () => HTMLImageElement;

type HeroTimerApi = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

type ReducedMotionListenerRegistrar = (
  listener: (reducedMotion: boolean) => void,
) => () => void;

export type HeroSceneOptions = {
  /** The shared frame owner. The adapter never creates its own animation loop. */
  scheduler: MotionScheduler;
  /** Dependency injection keeps the DOM boundary shallow and testable. */
  document?: Document;
  window?: Window;
  sceneName?: string;
  diagnostics?: HeroDiagnosticsPort;
  imageFactory?: HeroImageFactory;
  noiseImageFactory?: HeroImageFactory;
  imageSource?: (index: number) => string;
  noiseSource?: string;
  introReadiness?: IntroReadinessPolicy;
  reducedMotion?: boolean;
  reducedMotionQuery?: MediaQueryList;
  onReducedMotionChange?: ReducedMotionListenerRegistrar;
  timerApi?: HeroTimerApi;
  /** Disable the scene while retaining a named, inspectable registration. */
  disabled?: boolean;
  /**
   * Production defaults to automatic H → A → C selection. The C/A/H values
   * are a hidden diagnostics/test seam; no selector is rendered on the page.
   */
  rendererPreference?: ProductionHeroRendererPreference;
};

export type HeroSceneSnapshot = {
  phase: HeroPhase;
  active: boolean;
  autoplay: boolean;
  reducedMotion: boolean;
  exitHoldPending: boolean;
  readinessWatchdogPending: boolean;
  phaseStartTime: number | null;
  /** Elapsed time in the current timed phase, in milliseconds. */
  phaseElapsedMs: number;
  /** True only after the playing timeline has reached its terminal frame. */
  playbackCompleted: boolean;
  targetFrame: number;
  displayFrame: number;
  renderedFrame: number;
  pointerYNormalized: number;
  geometry: {
    stableHeight: number;
    boundary: number;
    stageTop: number;
    stageHeight: number;
    mobile: boolean;
    effectiveDpr: number;
  };
  assets: {
    requested: number;
    activeRequests: number;
    introRequestCountAtReady: number | null;
    laterQueueStarted: boolean;
    loaded: number;
    expected: number;
    introReady: boolean;
    allReady: boolean;
    pending: number;
    failed: number;
    degraded: boolean;
    fallbackCount: number;
    lastFrameSelection: AssetReadinessDiagnostics["lastFrameSelection"];
    failedAssets: AssetReadinessDiagnostics["failedAssets"];
    readiness: AssetReadinessDiagnostics;
  };
  overlays: {
    roleOpacity: number;
    experienceOpacity: number;
    cue: "role" | "experience" | "cta" | null;
    ctaAvailable: boolean;
    ctaOpacity: number;
    ctaPointerEvents: "none" | "all";
  };
  canvas: {
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    renderedAsset: {
      key: string;
      source: string;
      destination: { x: number; y: number; width: number; height: number };
      naturalWidth: number;
      naturalHeight: number;
    } | null;
  };
  renderer: {
    requested: ProductionHeroRenderer;
    active: ProductionHeroRenderer;
    selection: "automatic" | "forced";
    presentedFrame: number | null;
    visible: boolean;
    preparation: "idle" | "hidden" | "ready" | "failed";
    fallback: { from: ProductionHeroRenderer; to: "c"; reason: string } | null;
    source: string | null;
    assetId: string | null;
  };
  events: readonly HeroSceneEvent[];
};

export type HeroSceneEvent = {
  timeMs: number;
  from: string;
  event: string;
  to: string;
  reason: string;
};

export type HeroSceneHandle = {
  readonly scene: MotionSchedulerScene;
  readonly registry: AssetReadinessRegistry;
  readonly phase: HeroPhase;
  snapshot(): HeroSceneSnapshot;
  dispose(): void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

function padFrame(frame: number): string {
  return String(frame).padStart(3, "0");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function readOpacity(element: HTMLElement): number {
  const inline = Number.parseFloat(element.style.opacity);
  if (Number.isFinite(inline)) return inline;
  return 0;
}

function addClass(element: HTMLElement, name: string): void {
  element.classList.add(name);
}

function removeClass(element: HTMLElement, name: string): void {
  element.classList.remove(name);
}

function frameOpacity(
  frame: number,
  fadeIn: number,
  peak: number,
  fadeOut: number,
  end: number,
): number {
  if (frame < fadeIn || frame > end) return 0;
  if (frame < peak) return (frame - fadeIn) / (peak - fadeIn);
  if (frame < fadeOut) return 1;
  return 1 - (frame - fadeOut) / (end - fadeOut);
}

function defaultImageFactory(): HTMLImageElement {
  if (typeof Image === "undefined") {
    throw new Error("Hero scene requires an Image constructor outside a browser");
  }
  return new Image();
}

function defaultTimerApi(): HeroTimerApi {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function elementById<T extends HTMLElement>(document: Document, id: HeroElementId): T {
  const element = document.getElementById(id) as T | null;
  if (!element) throw new Error(`Hero scene element #${id} was not found`);
  return element;
}

function getWindow(options: HeroSceneOptions): Window {
  if (options.window) return options.window;
  if (typeof window !== "undefined") return window;
  throw new Error("Hero scene requires a Window outside a browser");
}

function getDocument(options: HeroSceneOptions): Document {
  if (options.document) return options.document;
  if (typeof document !== "undefined") return document;
  throw new Error("Hero scene requires a Document outside a browser");
}

function readHeroBackground(browserWindow: Window, browserDocument: Document): string {
  try {
    const configured = browserWindow
      .getComputedStyle(browserDocument.documentElement)
      .getPropertyValue("--bg")
      .trim();
    return configured || DEFAULT_HERO_BACKGROUND;
  } catch {
    return DEFAULT_HERO_BACKGROUND;
  }
}

function supportsMediaListener(
  query: MediaQueryList,
): query is MediaQueryList & {
  addEventListener(type: "change", listener: (event: MediaQueryListEvent) => void): void;
  removeEventListener(type: "change", listener: (event: MediaQueryListEvent) => void): void;
} {
  return typeof query.addEventListener === "function";
}

/**
 * Mounts the browser adapter for the hero image sequence.
 *
 * The adapter owns only DOM concerns: loading images, sampling the shared
 * hero contract, painting a canvas, and translating input to contract events.
 * Timeline, CTA, geometry, and fallback decisions stay in the motion modules.
 */
export function mountHeroScene(options: HeroSceneOptions): HeroSceneHandle {
  const browserWindow = getWindow(options);
  const browserDocument = getDocument(options);
  const scheduler = options.scheduler;
  const sceneName = options.sceneName ?? "hero";
  const diagnostics = options.diagnostics;
  const disabled = options.disabled === true;
  const imageFactory = options.imageFactory ?? defaultImageFactory;
  const noiseImageFactory = options.noiseImageFactory ?? imageFactory;
  const timerApi = options.timerApi ?? defaultTimerApi();
  const elements = {
    scrolly: elementById<HTMLElement>(browserDocument, "scrolly"),
    canvas: elementById<HTMLCanvasElement>(browserDocument, "scrolly-canvas"),
    loader: elementById<HTMLElement>(browserDocument, "scrolly-loader"),
    fill: elementById<HTMLElement>(browserDocument, "loader-fill"),
    photoStrip: elementById<HTMLElement>(browserDocument, "photo-strip"),
    st1: elementById<HTMLElement>(browserDocument, "st1"),
    st2: elementById<HTMLElement>(browserDocument, "st2"),
    noiseTop: elementById<HTMLElement>(browserDocument, "noise-top"),
    exploreCTA: elementById<HTMLElement>(browserDocument, "explore-cta"),
    hint: elementById<HTMLElement>(browserDocument, "scroll-hint"),
    nativeStage: elementById<HTMLElement>(browserDocument, "hero-native-stage"),
  };
  const context = elements.canvas.getContext("2d")!;
  if (!context) throw new Error("Hero scene requires a 2D canvas context");
  // Resolve the page surface once. Rendering then uses the same CSS token
  // without forcing a computed-style read on every animation frame.
  const heroBackground = readHeroBackground(browserWindow, browserDocument);

  // The shared lifecycle registrar owns preference state in the page
  // composition. MatchMedia is intentionally sampled only for a direct
  // consumer that did not supply that authority, avoiding an initialization
  // race between two reduced-motion sources.
  const query = options.onReducedMotionChange
    ? undefined
    : options.reducedMotionQuery ?? (() => {
        if (typeof browserWindow.matchMedia !== "function") return undefined;
        return browserWindow.matchMedia("(prefers-reduced-motion: reduce)");
      })();
  let reducedMotion =
    options.reducedMotion ??
    (options.onReducedMotionChange ? scheduler.reducedMotion : query?.matches ?? scheduler.reducedMotion);
  let disposed = false;
  let isVisible = true;
  let stableHeight: number | null = null;
  let lastMobile: boolean | null = null;
  let heroLayout: ReturnType<typeof computeHeroLayout> | null = null;
  let phase: HeroPhase = reducedMotion ? "reduced" : "loading";
  let phaseElapsedMs = 0;
  let phaseStartTime: number | null = null;
  let targetFrame: number = reducedMotion ? HERO_CONTRACT.endFrame : HERO_CONTRACT.startFrame;
  let displayFrame = targetFrame;
  let renderedAsset: HeroSceneSnapshot["canvas"]["renderedAsset"] = null;
  // This is deliberately distinct from `phase`: a direct navigation can
  // release an in-progress hero, while only a completed playback earns the
  // durable terminal experience copy.
  let playbackCompleted = false;
  let pointerYNormalized = 0.5;
  let ctaAvailable = reducedMotion;
  let exitHoldTimer: TimerHandle | null = null;
  let readinessTimer: TimerHandle | null = null;
  let geometrySettleTimer: TimerHandle | null = null;
  let phaseBeforeReducedMotion: HeroPhase | null = null;
  let touchStartY: number | null = null;
  let mobileGeometry: {
    boundary: number;
    stageTop: number;
    stageHeight: number;
    effectiveDpr: number;
    mobile: boolean;
  } = {
    boundary: 0,
    stageTop: 0,
    stageHeight: 0,
    effectiveDpr: 1,
    mobile: browserWindow.innerWidth <= HERO_BREAKPOINT,
  };
  const images = new Map<string, HTMLImageElement>();
  const imageSettled = new Set<string>();
  // `imageStarted` is the resident/in-flight set, not a lifetime request
  // ledger. Eviction removes a frame from this set so a later target can
  // request it again; `imageRequestCount` keeps diagnostics monotonic.
  const imageStarted = new Set<number>();
  const imageFailed = new Set<number>();
  let imageRequestCount = 0;
  const queuedFrames: number[] = [];
  const queuedFrameSet = new Set<number>();

  function frameKey(frame: number): string {
    return `frame-${padFrame(frame)}`;
  }

  function frameFromKey(key: string): number | null {
    const match = /^frame-(\d+)$/.exec(key);
    if (!match) return null;
    const frame = Number(match[1]);
    return Number.isInteger(frame) ? frame : null;
  }

  function disposeCachedImage(image: HTMLImageElement, frame: number): void {
    const key = frameKey(frame);
    if (images.get(key) === image) images.delete(key);
    imageStarted.delete(frame);
    imageSettled.delete(key);
    image.onload = null;
    image.onerror = null;
    // Removing the source is the important part of the memory contract: it
    // lets the browser release the decoded surface while retaining only the
    // small JS bookkeeping needed to request the frame again later.
    image.removeAttribute("src");
    image.removeAttribute("srcset");
  }

  const cFrameCache = new BoundedFrameCache<HTMLImageElement>(
    HERO_C_FRAME_CACHE_CAPACITY,
    disposeCachedImage,
  );
  let rendererRequested: ProductionHeroRenderer = "c";
  let rendererActive: ProductionHeroRenderer = "c";
  let rendererSelection: "automatic" | "forced" = options.rendererPreference && options.rendererPreference !== "auto"
    ? "forced"
    : "automatic";
  let rendererPreparation: "idle" | "hidden" | "ready" | "failed" = "idle";
  let rendererFallback: HeroSceneSnapshot["renderer"]["fallback"] = null;
  let nativeVideo: HTMLVideoElement | null = null;
  let nativePoster: HTMLImageElement | null = null;
  let nativePresentedFrame: number | null = null;
  let nativeVisible = false;
  let nativePreparationTimer: TimerHandle | null = null;
  let nativeAlphaProbeStop: (() => void) | null = null;
  let nativeMediaListenersStop: (() => void) | null = null;
  let nativeVideoFrameHandle: number | null = null;
  let nativeStopped = false;
  let nativePlaybackPhase: HeroPhase | null = null;
  let nativeFetchController: AbortController | null = null;
  let nativeObjectUrl: string | null = null;
  let nativeSource: string | null = null;
  let pendingNativeHandoff: {
    renderer: "h" | "a";
    targetFrame: number;
    preservedFrame: number;
  } | null = null;
  let cRendererStarted = false;
  const introFrameIndices = Array.from(
    { length: HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame + 1 },
    (_, offset) => HERO_CONTRACT.startFrame + offset,
  );
  let introCursor = 0;
  let laterQueueStarted = false;
  let activeImageLoads = 0;
  let introRequestCountAtReady: number | null = null;
  const listeners: Array<() => void> = [];
  const events: HeroSceneEvent[] = [];
  const registry = new AssetReadinessRegistry(
    Array.from({ length: HERO_CONTRACT.totalFrameCount }, (_, frame) => ({
      key: `frame-${padFrame(frame)}`,
      frame,
      phase: frame <= HERO_CONTRACT.introEndFrame ? ("intro" as const) : ("later" as const),
    })),
    {
      intro: {
        minReady: HERO_CONTRACT.introEndFrame - HERO_CONTRACT.startFrame + 1,
        ...options.introReadiness,
        allowFailed: true,
      },
    },
  );
  const noiseImage = noiseImageFactory();
  let noiseRequested = false;
  const scene = scheduler.register(sceneName, onFrame, { active: false });

  function nowMs(): number {
    if (typeof browserWindow.performance?.now === "function") return browserWindow.performance.now();
    return Date.now();
  }

  function recordEvent(event: string, from: string, to: string, reason: string): void {
    events.push({ timeMs: nowMs(), from, event, to, reason });
    if (events.length > MAX_DIAGNOSTIC_EVENTS) events.splice(0, events.length - MAX_DIAGNOSTIC_EVENTS);
  }

  function cachedFrameKeys(): ReadonlySet<string> {
    return new Set(cFrameCache.frames().map(frameKey));
  }

  function requestImage(index: number, providedImage?: HTMLImageElement): void {
    if (
      disposed
      || imageStarted.has(index)
      || imageFailed.has(index)
      || cFrameCache.has(index)
    ) return;
    imageStarted.add(index);
    imageRequestCount += 1;
    loadImage(index, providedImage);
  }

  function queueImage(index: number, front = false): void {
    const normalized = clamp(Math.round(index), HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame);
    if (
      imageStarted.has(normalized)
      || imageFailed.has(normalized)
      || cFrameCache.has(normalized)
      || queuedFrameSet.has(normalized)
    ) return;
    queuedFrameSet.add(normalized);
    if (front) queuedFrames.unshift(normalized);
    else queuedFrames.push(normalized);
  }

  /**
   * Keep only a small, target-centered request neighborhood. In-flight
   * requests cannot be cancelled portably, but stale queued requests are
   * dropped before they consume another decode slot.
   */
  function queueCFrameWindow(requestedFrame: number, extraFrames: readonly number[] = []): void {
    if (!cRendererStarted || !laterQueueStarted) return;
    const center = clamp(Math.round(requestedFrame), HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame);
    const window = new Set(prefetchFrames(center, HERO_CONTRACT.totalFrameCount, HERO_C_PREFETCH_RADIUS));
    for (const extra of extraFrames) {
      if (!Number.isFinite(extra)) continue;
      for (const frame of prefetchFrames(
        clamp(Math.round(extra), HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame),
        HERO_CONTRACT.totalFrameCount,
        HERO_C_PREFETCH_RADIUS,
      )) window.add(frame);
    }
    for (let cursor = queuedFrames.length - 1; cursor >= 0; cursor -= 1) {
      const queued = queuedFrames[cursor];
      if (!window.has(queued)) {
        queuedFrames.splice(cursor, 1);
        queuedFrameSet.delete(queued);
      }
    }
    // The exact target is first, followed by the forward and backward
    // neighborhood. This makes a fast forward scroll useful immediately
    // while still allowing nearest-ready rendering in either direction.
    queueImage(center, true);
    for (let offset = 1; offset <= HERO_C_PREFETCH_RADIUS; offset += 1) {
      queueImage(center + offset);
      queueImage(center - offset);
    }
    for (const extra of extraFrames) {
      if (Number.isFinite(extra)) queueImage(extra);
    }
    pumpImageQueue();
  }

  function setPhase(next: HeroPhase, event: string, reason: string): void {
    if (phase === next) return;
    const previous = phase;
    phase = next;
    if (next === "reduced") phaseBeforeReducedMotion = previous;
    else if (previous === "reduced") phaseBeforeReducedMotion = null;
    phaseElapsedMs = 0;
    phaseStartTime = null;
    recordEvent(event, previous, next, reason);
    if (next === "reduced") {
      if (readinessTimer !== null) {
        timerApi.clearTimeout(readinessTimer);
        readinessTimer = null;
      }
      if (geometrySettleTimer !== null) {
        timerApi.clearTimeout(geometrySettleTimer);
        geometrySettleTimer = null;
      }
      if (exitHoldTimer !== null) {
        timerApi.clearTimeout(exitHoldTimer);
        exitHoldTimer = null;
      }
      targetFrame = HERO_CONTRACT.endFrame;
      displayFrame = HERO_CONTRACT.endFrame;
      ctaAvailable = true;
      deactivateScene();
    }
  }

  function transition(event: Parameters<typeof transitionHeroPhase>[1], reason: string): void {
    const next = transitionHeroPhase(phase, event);
    if (next !== phase) setPhase(next, event, reason);
  }

  function activateScene(): void {
    if (disposed || disabled || reducedMotion || !isVisible) return;
    try {
      scene.activate();
    } catch {
      // A parent lifecycle may dispose its scheduler before this adapter. The
      // adapter is already inert in that case, so no work can be recovered.
    }
  }

  function deactivateScene(): void {
    if (disposed) return;
    try {
      scene.deactivate();
    } catch {
      // See activateScene: disposal is terminal and intentionally idempotent.
    }
  }

  function canvasRect(): DOMRect {
    return elements.canvas.getBoundingClientRect();
  }

  function nativeDimensions(renderer: ProductionHeroRenderer): { width: number; height: number } {
    // Do not derive layout from video.videoWidth/videoHeight: H is coded at
    // 1280×720 while the source/C contract is 900×507. Both native surfaces
    // therefore occupy the exact C content rectangle and avoid 900×508
    // intrinsic-ratio drift from the Apple staging encode.
    return { width: HERO_NATIVE_CONTENT_WIDTH, height: HERO_NATIVE_CONTENT_HEIGHT };
  }

  function syncNativeGeometry(): void {
    if (!nativeVideo && !nativePoster) return;
    const layout = heroLayout;
    const nativeRenderer = rendererActive === "c"
      ? pendingNativeHandoff?.renderer
      : rendererActive;
    if (!layout || !nativeRenderer) return;
    const dimensions = nativeDimensions(nativeRenderer);
    const cw = Math.max(1, layout.canvas.width);
    const ch = Math.max(1, layout.canvas.height);
    const placement = mobileGeometry.mobile
      ? computeMobileHeroAssetPlacement({
          canvasWidth: cw,
          canvasHeight: ch,
          naturalWidth: dimensions.width,
          naturalHeight: dimensions.height,
        })
      : (() => {
          const scale = Math.max(cw / dimensions.width, ch / dimensions.height) * 0.59;
          const width = dimensions.width * scale;
          const height = dimensions.height * scale;
          return { scale, x: (cw - width) / 2, y: ch - height, width, height };
        })();
    const setPlacement = (element: HTMLElement): void => {
      element.style.left = `${placement.x}px`;
      element.style.top = `${placement.y}px`;
      element.style.width = `${placement.width}px`;
      element.style.height = `${placement.height}px`;
    };
    if (nativeVideo) setPlacement(nativeVideo);
    if (nativePoster) setPlacement(nativePoster);
  }

  function clearNativePreparationTimer(): void {
    if (nativePreparationTimer === null) return;
    timerApi.clearTimeout(nativePreparationTimer);
    nativePreparationTimer = null;
  }

  function updateNativePresentedFrame(currentTimeSeconds: number): void {
    if (!Number.isFinite(currentTimeSeconds)) return;
    nativePresentedFrame = clamp(
      nativeFrameFromSeconds(currentTimeSeconds),
      HERO_CONTRACT.startFrame,
      HERO_NATIVE_END_FRAME,
    );
  }

  function stopNativeFrameObservation(): void {
    const video = nativeVideo as (HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    }) | null;
    if (video && nativeVideoFrameHandle !== null && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(nativeVideoFrameHandle);
    }
    nativeVideoFrameHandle = null;
  }

  function observeNativePresentedFrame(video: HTMLVideoElement): void {
    const frameVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (timestampMs: number, metadata: { mediaTime: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const observe = (): void => {
      if (nativeStopped || nativeVideo !== video || typeof frameVideo.requestVideoFrameCallback !== "function") return;
      nativeVideoFrameHandle = frameVideo.requestVideoFrameCallback((_timestampMs, metadata) => {
        nativeVideoFrameHandle = null;
        if (nativeStopped || nativeVideo !== video) return;
        updateNativePresentedFrame(metadata.mediaTime);
        observe();
      });
    };
    if (typeof frameVideo.requestVideoFrameCallback === "function") observe();
  }

  function stopNativeCandidate(): void {
    nativeStopped = true;
    nativeFetchController?.abort();
    nativeFetchController = null;
    clearNativePreparationTimer();
    nativeAlphaProbeStop?.();
    nativeAlphaProbeStop = null;
    nativeMediaListenersStop?.();
    nativeMediaListenersStop = null;
    stopNativeFrameObservation();
    if (nativeVideo) {
      nativeVideo.pause();
      nativeVideo.removeAttribute("src");
      nativeVideo.load();
    }
    if (nativeObjectUrl) URL.revokeObjectURL(nativeObjectUrl);
    nativeObjectUrl = null;
    nativeSource = null;
    nativeVideo = null;
    nativePoster = null;
    nativeVisible = false;
    pendingNativeHandoff = null;
    elements.nativeStage.replaceChildren();
    removeClass(elements.nativeStage, "active");
    removeClass(elements.nativeStage, "visible");
  }

  /**
   * Freeze a visible native surface in place while C decodes a nearby frame.
   * It is important that this is not `stopNativeCandidate()`: clearing the
   * media source before the C gate passes creates the exact frame-0 blink the
   * fallback policy is meant to prevent.
   */
  function suspendNativeCandidateForHandoff(): void {
    nativeStopped = true;
    nativeFetchController?.abort();
    nativeFetchController = null;
    clearNativePreparationTimer();
    nativeAlphaProbeStop?.();
    nativeAlphaProbeStop = null;
    nativeMediaListenersStop?.();
    nativeMediaListenersStop = null;
    stopNativeFrameObservation();
    if (nativeVideo) {
      nativeVideo.pause();
      if (nativePresentedFrame === null) updateNativePresentedFrame(nativeVideo.currentTime);
    }
  }

  function startCRenderer(reason: string): void {
    if (disposed || cRendererStarted) return;
    const wasNative = rendererActive !== "c" || nativeVideo !== null || nativePoster !== null;
    const preserveTimeline = wasNative && nativeVisible && phase !== "loading";
    if (preserveTimeline && (rendererActive === "h" || rendererActive === "a")) {
      pendingNativeHandoff = {
        renderer: rendererActive,
        targetFrame: clamp(targetFrame, HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame),
        preservedFrame: clamp(
          nativePresentedFrame ?? displayFrame,
          HERO_CONTRACT.startFrame,
          HERO_CONTRACT.endFrame,
        ),
      };
      suspendNativeCandidateForHandoff();
    } else {
      stopNativeCandidate();
    }
    rendererActive = "c";
    rendererPreparation = wasNative ? "failed" : "idle";
    cRendererStarted = true;
    recordEvent("renderer-active", "pending", "c", reason);
    if (preserveTimeline) {
      // Renderer failure must not rewind the application state or relock
      // scrolling. Prime the current visual neighborhood while preserving
      // phase, elapsed time, frame, CTA latch, and released state exactly.
      addClass(elements.loader, "hidden");
      const center = clamp(
        Math.round(pendingNativeHandoff?.preservedFrame ?? displayFrame),
        HERO_CONTRACT.startFrame,
        HERO_CONTRACT.endFrame,
      );
      laterQueueStarted = true;
      queueCFrameWindow(
        center,
        [
          clamp(
            Math.round(pendingNativeHandoff?.targetFrame ?? targetFrame),
            HERO_CONTRACT.startFrame,
            HERO_CONTRACT.endFrame,
          ),
        ],
      );
      pumpImageQueue();
      render();
      recordEvent("renderer-fallback-preserved", "native", "c", `phase=${phase}; frame=${center}`);
      maybeCompleteNativeHandoff();
      return;
    }
    removeClass(elements.loader, "hidden");
    pumpImageQueue();
    beginIntroIfReady("C assets already ready");
    armReadinessWatchdog();
    render();
  }

  function maybeCompleteNativeHandoff(): boolean {
    const handoff = pendingNativeHandoff;
    if (!handoff || rendererActive !== "c" || disposed) return false;
    const selection = registry.selectFrame(handoff.targetFrame, cachedFrameKeys());
    const image = selection.renderedFrame === null ? undefined : cFrameCache.get(selection.renderedFrame);
    const decoded = Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    if (!shouldCommitNativeFallbackHandoff({
      targetFrame: handoff.targetFrame,
      renderedFrame: selection.renderedFrame,
      decoded,
    })) return false;

    // Every timeline/navigation field is intentionally untouched. Only the
    // renderer surface changes, and both surfaces are already in the same
    // task, so the browser cannot paint an intermediate frame-0 state.
    pendingNativeHandoff = null;
    stopNativeCandidate();
    recordEvent(
      "renderer-handoff",
      "native",
      "c",
      `target=${handoff.targetFrame}; frame=${selection.renderedFrame}; tolerance=${HERO_NATIVE_FALLBACK_FRAME_TOLERANCE}`,
    );
    render();
    return true;
  }

  function failNativeCandidate(reason: string): void {
    if (disposed || nativeStopped || rendererActive === "c") return;
    const from = rendererActive;
    const to = fallbackProductionHeroRenderer(from);
    if (to === null) return;
    rendererFallback = { from, to, reason };
    rendererPreparation = "failed";
    recordEvent("renderer-fallback", from, to, reason);
    startCRenderer(reason);
  }

  function acceptNativeCandidate(kind: "h" | "a"): void {
    if (disposed || nativeStopped || rendererActive !== kind || !nativeVideo) return;
    clearNativePreparationTimer();
    rendererPreparation = "ready";
    nativeVisible = true;
    addClass(elements.nativeStage, "visible");
    nativeVideo.style.visibility = "visible";
    nativePoster?.remove();
    nativePoster = null;
    addClass(elements.loader, "hidden");
    recordEvent("renderer-ready", kind, kind, kind === "a" ? "decoded alpha proof passed" : "loadeddata and canplay passed");
    beginNativeIntro(kind);
  }

  function beginNativeIntro(kind: "h" | "a"): void {
    if (disposed || nativeStopped || rendererActive !== kind || phase !== "loading" || !nativeVideo) return;
    clearReadinessTimer();
    transition("assets-ready", `${kind.toUpperCase()} native candidate ready`);
    activateScene();
    nativePlaybackPhase = null;
    nativeVideo.currentTime = nativeFrameToSeconds(HERO_CONTRACT.startFrame);
    nativeVideo.playbackRate = nativeIntroPlaybackRate();
    updateNativePresentedFrame(nativeVideo.currentTime);
    render();
    if (isVisible) {
      void nativeVideo.play().catch((error: unknown) => {
        failNativeCandidate(`native ${kind.toUpperCase()} playback start failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  function alphaProbeForNative(video: HTMLVideoElement, onPass: () => void, onFail: (reason: string) => void): () => void {
    const probe = browserDocument.createElement("canvas");
    probe.width = 2;
    probe.height = 2;
    const context = probe.getContext("2d", { willReadFrequently: true });
    let complete = false;
    let frameHandle: number | null = null;
    const check = (): void => {
      frameHandle = null;
      if (complete || nativeStopped || nativeVideo !== video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (!context) {
        complete = true;
        onFail("A decoded alpha probe has no 2D canvas context");
        return;
      }
      try {
        context.clearRect(0, 0, probe.width, probe.height);
        context.drawImage(video, 0, 0, probe.width, probe.height);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        complete = true;
        if (hasTransparentProbePixel(pixels)) onPass();
        else onFail("A decoded alpha probe found an opaque frame");
      } catch (error) {
        complete = true;
        onFail(`A decoded alpha probe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const schedule = (): void => {
      if (complete || frameHandle !== null) return;
      frameHandle = browserWindow.requestAnimationFrame(check);
    };
    const onLoadedData = (): void => schedule();
    const onCanPlay = (): void => schedule();
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("canplay", onCanPlay);
    schedule();
    return () => {
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("canplay", onCanPlay);
      if (frameHandle !== null) browserWindow.cancelAnimationFrame(frameHandle);
      frameHandle = null;
    };
  }

  async function verifyNativeBlob(kind: "h" | "a", blob: Blob): Promise<Blob> {
    if (kind !== "h") return blob;
    const subtle = browserWindow.crypto?.subtle;
    if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable");
    const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== HERO_NATIVE_H_SHA256) {
      throw new Error(`asset SHA-256 mismatch: ${actual}`);
    }
    return blob;
  }

  function prepareNativeCandidate(kind: "h" | "a"): void {
    rendererActive = kind;
    rendererPreparation = "hidden";
    nativeStopped = false;
    const source = kind === "h" ? HERO_NATIVE_H_SOURCE : HERO_NATIVE_A_SOURCE;
    nativeSource = source;
    const dimensions = nativeDimensions(kind);
    const poster = imageFactory();
    poster.className = "hero-native-poster";
    poster.alt = "";
    poster.decoding = "async";
    poster.setAttribute("aria-hidden", "true");
    // A reduced-motion toggle can re-enter native preparation after C has
    // already cached frame 0. Replace that cache entry explicitly so the
    // poster request cannot be mistaken for an already-started C request.
    cFrameCache.delete(0);
    images.delete("frame-000");
    imageSettled.delete("frame-000");
    imageFailed.delete(0);
    imageStarted.delete(0);
    nativePoster = poster;
    images.set("frame-000", poster);
    elements.nativeStage.replaceChildren(poster);
    addClass(elements.nativeStage, "active");
    requestImage(0, poster);

    const video = browserDocument.createElement("video");
    video.className = "hero-native-video";
    video.autoplay = false;
    video.defaultMuted = true;
    video.muted = true;
    video.loop = false;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("muted", "");
    video.setAttribute("aria-hidden", "true");
    video.dataset.renderer = kind === "h" ? "hevc-alpha-dom" : "vp9-alpha-dom";
    video.dataset.assetId = kind === "h" ? HERO_NATIVE_H_ASSET_ID : "hero-alpha-vp9-v1";
    if (kind === "h") video.dataset.assetSha256 = HERO_NATIVE_H_SHA256;
    video.dataset.contentWidth = String(dimensions.width);
    video.dataset.contentHeight = String(dimensions.height);
    video.style.visibility = "hidden";
    nativeVideo = video;
    elements.nativeStage.append(video);
    syncNativeGeometry();

    let loadedData = false;
    let canPlay = false;
    let alphaProof = kind === "h";
    const maybeAccept = (): void => {
      if (nativeCandidateCanExpose(kind, { loadedData, canPlay, alphaProof })) {
        acceptNativeCandidate(kind);
      }
    };
    const onLoadedMetadata = (): void => {
      syncNativeGeometry();
      updateNativePresentedFrame(video.currentTime);
      recordEvent("native-loadedmetadata", kind, kind, `${video.videoWidth}×${video.videoHeight}`);
    };
    const onLoadedData = (): void => {
      loadedData = true;
      updateNativePresentedFrame(video.currentTime);
      maybeAccept();
    };
    const onCanPlay = (): void => {
      canPlay = true;
      maybeAccept();
    };
    const onTimeUpdate = (): void => updateNativePresentedFrame(video.currentTime);
    const onPlaying = (): void => {
      updateNativePresentedFrame(video.currentTime);
      observeNativePresentedFrame(video);
    };
    const onError = (): void => {
      const detail = video.error ? `code ${video.error.code}${video.error.message ? ` (${video.error.message})` : ""}` : "unknown media error";
      failNativeCandidate(`${kind.toUpperCase()} media error: ${detail}`);
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("error", onError);
    nativeMediaListenersStop = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("error", onError);
    };
    if (kind === "a") {
      nativeAlphaProbeStop = alphaProbeForNative(video, () => {
        alphaProof = true;
        maybeAccept();
      }, (reason) => failNativeCandidate(reason));
    }
    nativePreparationTimer = timerApi.setTimeout(() => {
      nativePreparationTimer = null;
      failNativeCandidate(`${kind.toUpperCase()} preparation timed out after ${HERO_NATIVE_PREPARATION_DEADLINE_MS} ms`);
    }, HERO_NATIVE_PREPARATION_DEADLINE_MS);
    // The poster is the only image loaded while a native candidate is being
    // qualified. The full C sequence starts only after a candidate fails.
    addClass(elements.loader, "hidden");
    const fetchController = new AbortController();
    nativeFetchController = fetchController;
    void browserWindow.fetch(source, { signal: fetchController.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`media response ${response.status}`);
        return response.blob();
      })
      .then((blob) => verifyNativeBlob(kind, blob))
      .then((blob) => {
        if (nativeStopped || nativeVideo !== video || fetchController.signal.aborted) return;
        if (blob.size <= 0) throw new Error("empty media Blob");
        nativeFetchController = null;
        const objectUrl = URL.createObjectURL(blob);
        nativeObjectUrl = objectUrl;
        video.src = objectUrl;
        video.load();
      })
      .catch((error: unknown) => {
        if (fetchController.signal.aborted || nativeStopped) return;
        nativeFetchController = null;
        failNativeCandidate(`native ${kind.toUpperCase()} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    render();
  }

  function initializeRenderer(): void {
    if (disabled || reducedMotion) {
      rendererRequested = "c";
      rendererActive = "c";
      cRendererStarted = true;
      return;
    }
    const probe = browserDocument.createElement("video");
    const hevcCanPlayType = probe.canPlayType(HERO_HEVC_ALPHA_MIME);
    const vp9CanPlayType = probe.canPlayType(HERO_VP9_ALPHA_MIME);
    const selected = selectProductionHeroRenderer({
      preference: options.rendererPreference,
      hevcCanPlayType,
      vp9CanPlayType,
      hevcEnvironmentQualified: isProductionHevcAlphaQualified({
        vendor: browserWindow.navigator.vendor,
        userAgent: browserWindow.navigator.userAgent,
        canPlayType: hevcCanPlayType,
        sourceUrl: HERO_NATIVE_H_SOURCE,
        assetId: HERO_NATIVE_H_ASSET_ID,
        assetSha256: HERO_NATIVE_H_SHA256,
      }),
      safariProfileDetected: isAppleSafariProfile({
        vendor: browserWindow.navigator.vendor,
        userAgent: browserWindow.navigator.userAgent,
      }),
    });
    rendererRequested = selected;
    recordEvent("renderer-selection", "pending", selected, `${options.rendererPreference && options.rendererPreference !== "auto" ? "forced" : "automatic"}; hevc=${hevcCanPlayType || "unsupported"}; vp9=${vp9CanPlayType || "unsupported"}`);
    if (selected === "c") {
      startCRenderer("no claimed native codec");
      return;
    }
    try {
      prepareNativeCandidate(selected);
    } catch (error) {
      failNativeCandidate(`${selected.toUpperCase()} initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function ensureNoiseLoaded(): void {
    if (noiseRequested || mobileGeometry.mobile) return;
    noiseRequested = true;
    noiseImage.src = options.noiseSource ?? DEFAULT_NOISE_SOURCE;
  }

  function syncGeometry(force: boolean): void {
    // Size the backing store from the canvas' layout viewport, not innerWidth:
    // desktop scrollbar gutters can otherwise make the bitmap wider than its
    // CSS box and introduce a subtle horizontal squeeze.
    const measuredWidth = elements.scrolly.getBoundingClientRect().width;
    const rootWidth = browserDocument.documentElement.clientWidth;
    const width = Math.max(
      1,
      finiteOr(measuredWidth || rootWidth || browserWindow.innerWidth, 1),
    );
    const visualHeight = Math.max(
      1,
      finiteOr(browserWindow.visualViewport?.height ?? browserWindow.innerHeight, stableHeight ?? 1),
    );
    const mobile = width <= HERO_BREAKPOINT;
    const orientationChanged = lastMobile !== null && lastMobile !== mobile;
    const innerHeight = Math.max(1, finiteOr(browserWindow.innerHeight, 1));
    // Mobile Safari can report the collapsed address-bar viewport on the
    // first pass and a taller layout viewport once its visual viewport settles.
    // Keep the first-screen contract monotonic within an orientation so the
    // canvas cannot initialize at a transient quarter-sized stage. A real
    // orientation transition calls this with `force` and establishes a new
    // baseline; toolbar collapse/expand never shrinks an already-established
    // first screen.
    const observedHeight = mobile ? Math.max(innerHeight, visualHeight) : innerHeight;
    if (force || orientationChanged || stableHeight === null || !mobile) {
      stableHeight = observedHeight;
    } else if (mobile) {
      stableHeight = Math.max(stableHeight, observedHeight);
    }
    lastMobile = mobile;
    const dpr = finiteOr(browserWindow.devicePixelRatio || 1, 1);
    // Geometry is one contract for both modes.  The adapter only translates
    // the result to CSS variables/DOM properties; it does not maintain a
    // second desktop formula beside the tested mobile one.
    const layout = computeHeroLayout({
      width,
      visualHeight,
      stableHeight,
      dpr,
      mode: mobile ? "mobile" : "desktop",
    });
    heroLayout = layout;
    const boundary = layout.boundaryY;
    const stageTop = layout.stage.top;
    const stageHeight = layout.stage.height;
    const effectiveDpr = layout.backingStore.effectiveDpr;
    mobileGeometry = { boundary, stageTop, stageHeight, effectiveDpr, mobile };

    const root = browserDocument.documentElement.style;
    root.setProperty("--hero-stable-h", `${stableHeight}px`);
    root.setProperty("--hero-boundary", `${boundary}px`);
    root.setProperty("--hero-overlap", `${layout.aboutOverlap}px`);
    root.setProperty("--hero-stage-top", `${stageTop}px`);
    root.setProperty("--hero-stage-height", `${stageHeight}px`);
    root.setProperty("--hero-copy-top", `${layout.copyAnchor.y}px`);
    root.setProperty("--hero-copy-role-x", `${layout.copyAnchors.role.x}px`);
    root.setProperty("--hero-copy-experience-x", `${layout.copyAnchors.experience.x}px`);

    elements.canvas.width = Math.max(1, layout.backingStore.width);
    elements.canvas.height = Math.max(1, layout.backingStore.height);
    context.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);
    elements.photoStrip.style.top = `${layout.boundary.top}px`;
    elements.exploreCTA.style.top = `${layout.ctaAnchor.y}px`;
    elements.hint.style.top = `${layout.hintAnchor.y}px`;
    elements.noiseTop.style.height = `${Math.round(boundary)}px`;
    syncNativeGeometry();
  }

  function beginIntroIfReady(reason: string): void {
    if (disposed || disabled || reducedMotion || phase !== "loading" || !registry.introReady) return;
    if (!hasRenderableHeroFrame()) {
      releaseUnavailableHero("intro assets settled without a drawable frame");
      return;
    }
    if (introRequestCountAtReady === null) introRequestCountAtReady = imageRequestCount;
    clearReadinessTimer();
    addClass(elements.loader, "hidden");
    transition("assets-ready", reason);
    // The intro gate is complete. From this point on, C is demand-driven and
    // only requests a target-centered neighborhood instead of draining the
    // remaining sequence into memory.
    laterQueueStarted = true;
    activateScene();
    draw(displayFrame);
  }

  function updateLoader(): void {
    const readiness = registry.diagnostics();
    const settled = readiness.ready + readiness.failed;
    elements.fill.style.width = `${(settled / readiness.expected) * 100}%`;
    if (registry.introReady) addClass(elements.loader, "hidden");
  }

  function markImageReady(key: string): void {
    if (disposed || imageSettled.has(key)) return;
    const frame = frameFromKey(key);
    const image = images.get(key);
    if (frame === null || !image) return;
    imageSettled.add(key);
    activeImageLoads = Math.max(0, activeImageLoads - 1);
    cFrameCache.set(frame, image);
    registry.markReady(key);
    if (nativePoster === image) syncNativeGeometry();
    resetReadinessWatchdog(key);
    updateLoader();
    recordEvent("asset-ready", "asset", "ready", key);
    beginIntroIfReady("intro assets ready");
    maybeCompleteNativeHandoff();
    if (reducedMotion || (rendererActive === "c" && phase !== "loading")) render();
    pumpImageQueue();
  }

  function markImageFailed(key: string, error: unknown, code = "image-load-failed"): void {
    if (disposed || imageSettled.has(key)) return;
    const frame = frameFromKey(key);
    const image = images.get(key);
    imageSettled.add(key);
    activeImageLoads = Math.max(0, activeImageLoads - 1);
    if (frame !== null) imageFailed.add(frame);
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      images.delete(key);
    }
    const message = error instanceof Error ? error.message : String(error || "image failed");
    registry.markFailed(key, { code, message });
    if (nativePoster === image && rendererPreparation === "hidden") {
      failNativeCandidate(`frame-0 poster failed: ${message}`);
    }
    resetReadinessWatchdog(key);
    updateLoader();
    recordEvent("asset-failed", "asset", "failed", `${key}: ${message}`);
    beginIntroIfReady("intro assets ready with named failures");
    if (reducedMotion || (rendererActive === "c" && phase !== "loading")) render();
    pumpImageQueue();
  }

  function reportDecodeFailure(key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || "image decode failed");
    // `load` plus valid natural dimensions is the readiness boundary. Decode
    // remains an observability signal only: Safari has exposed a decode()
    // promise that can stay pending even though drawImage is already valid.
    recordEvent("asset-decode-failed", "asset", "ready", `${key}: ${message}`);
  }

  function observeDecode(key: string, image: HTMLImageElement): void {
    if (typeof image.decode !== "function") return;
    try {
      // Attach rejection handling without making readiness wait on this
      // optional decoder promise. Promise.resolve also handles Safari's
      // thenable implementations consistently.
      void Promise.resolve(image.decode()).catch((error: unknown) => {
        if (!disposed) reportDecodeFailure(key, error);
      });
    } catch (error) {
      if (!disposed) reportDecodeFailure(key, error);
    }
  }

  function loadImage(index: number, providedImage?: HTMLImageElement): void {
    const key = `frame-${padFrame(index)}`;
    let image: HTMLImageElement;
    activeImageLoads += 1;
    try {
      image = providedImage ?? imageFactory();
    } catch (error) {
      markImageFailed(key, error, "image-factory-failed");
      return;
    }
    images.set(key, image);
    image.onload = () => {
      // A native load event with usable natural dimensions is immediately
      // drawable. Do not gate the first-screen transition on decode(), whose
      // promise is optional and can stall indefinitely on Mobile Safari.
      if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
        markImageReady(key);
        observeDecode(key, image);
      } else {
        markImageFailed(key, new Error("loaded image has no natural dimensions"), "loaded-without-dimensions");
      }
    };
    image.onerror = (error) => markImageFailed(key, error, "network-failed");
    image.src = options.imageSource?.(index) ?? `${DEFAULT_IMAGE_PREFIX}${padFrame(index)}${DEFAULT_IMAGE_SUFFIX}`;
  }

  function pumpImageQueue(): void {
    if (disposed || disabled || phase === "released" || phase === "reduced" || !cRendererStarted) return;
    if (!laterQueueStarted) {
      while (activeImageLoads < HERO_C_INTRO_LOAD_CONCURRENCY && introCursor < introFrameIndices.length) {
        const index = introFrameIndices[introCursor];
        introCursor += 1;
        requestImage(index);
      }
      return;
    }
    while (activeImageLoads < HERO_C_LOAD_CONCURRENCY && queuedFrames.length > 0) {
      const next = queuedFrames.shift();
      if (next === undefined) break;
      queuedFrameSet.delete(next);
      requestImage(next);
    }
  }

  function clearReadinessTimer(): void {
    if (readinessTimer === null) return;
    timerApi.clearTimeout(readinessTimer);
    readinessTimer = null;
  }

  function isIntroAsset(key: string): boolean {
    return registry.record(key).phase === "intro";
  }

  function hasRenderableHeroFrame(): boolean {
    return registry.expectations.some((expectation) => {
      if (expectation.frame === undefined || registry.status(expectation.key) !== "ready") return false;
      const image = images.get(expectation.key);
      return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    });
  }

  function releaseUnavailableHero(reason: string): void {
    if (disposed || disabled || reducedMotion || phase !== "loading") return;
    clearReadinessTimer();
    addClass(elements.loader, "hidden");
    transition("release", reason);
    deactivateScene();
    render();
  }

  function onReadinessTimeout(): void {
    readinessTimer = null;
    if (disposed || disabled || reducedMotion || phase !== "loading" || !cRendererStarted) return;
    // A partial ready set is still useful for a static fallback, but the
    // hero must not claim the N1 input lock unless intro readiness actually
    // completed. Releasing here lets native scroll/click input recover.
    if (registry.introReady && hasRenderableHeroFrame()) {
      beginIntroIfReady("readiness watchdog observed intro assets");
    } else {
      releaseUnavailableHero("hero asset readiness timeout");
    }
  }

  function armReadinessWatchdog(): void {
    if (
      disposed ||
      disabled ||
      reducedMotion ||
      phase !== "loading" ||
      !cRendererStarted ||
      readinessTimer !== null
    ) return;
    readinessTimer = timerApi.setTimeout(onReadinessTimeout, HERO_READINESS_TIMEOUT_MS);
  }

  function resetReadinessWatchdog(key: string): void {
    // Native preparation owns its own deadline. The frame-0 poster is entered
    // in the same registry as C's frames so it remains drawable after a late
    // fallback, but it must not arm the C readiness watchdog while H/A is
    // still being qualified.
    if (
      disposed
      || disabled
      || reducedMotion
      || phase !== "loading"
      || !cRendererStarted
      || !isIntroAsset(key)
    ) return;
    clearReadinessTimer();
    readinessTimer = timerApi.setTimeout(onReadinessTimeout, HERO_READINESS_TIMEOUT_MS);
  }

  function drawBackdrop(cw: number, ch: number): void {
    // Transparent hero frames must reveal the same surface as the rest of
    // the first screen. A gradient here made the background visibly drift
    // across the canvas and left transparent photo areas on different hues.
    context.fillStyle = heroBackground;
    context.fillRect(0, 0, cw, ch);
  }

  function draw(requestedFrame: number): void {
    if (disposed) return;
    // All layout and painting uses CSS pixels. DPR only affects the backing
    // store transform established in syncGeometry(), preventing narrow mobile
    // canvases from composing at 2x coordinates and then being squeezed down.
    const cw = Math.max(1, heroLayout?.canvas.width ?? canvasRect().width);
    const ch = Math.max(1, heroLayout?.canvas.height ?? canvasRect().height);
    drawBackdrop(cw, ch);
    if (rendererActive === "c") queueCFrameWindow(requestedFrame);
    const selection = rendererActive === "c"
      ? registry.selectFrame(
          clamp(requestedFrame, HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame),
          cachedFrameKeys(),
        )
      : null;
    const image = selection && selection.renderedFrame !== null
      ? cFrameCache.get(selection.renderedFrame)
      : undefined;
    const validImage = image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    const isMobile = mobileGeometry.mobile;
    renderedAsset = null;

    context.save();
    context.textAlign = "center";
    context.fillStyle = "#ffffff";
    const firstSize = Math.min(cw * 0.17, 230);
    context.font = `800 ${firstSize}px Syne, sans-serif`;
    const firstWidth = context.measureText("IRINA").width;
    const fittedFirstSize = firstWidth > cw * 0.9 ? firstSize * ((cw * 0.9) / firstWidth) : firstSize;
    context.font = `800 ${fittedFirstSize}px Syne, sans-serif`;
    context.globalAlpha = 0.92;
    context.fillText("IRINA", cw / 2, ch * (isMobile ? 0.71 : 0.47));
    const secondSize = Math.min(cw * 0.093, 128);
    context.font = `800 ${secondSize}px Syne, sans-serif`;
    const secondWidth = context.measureText("IVASHCHENKO").width;
    const fittedSecondSize = secondWidth > cw * 0.9 ? secondSize * ((cw * 0.9) / secondWidth) : secondSize;
    context.font = `800 ${fittedSecondSize}px Syne, sans-serif`;
    context.fillText("IVASHCHENKO", cw / 2, ch * (isMobile ? 0.88 : 0.66));
    context.restore();

    if (rendererActive === "c" && validImage) {
      const iw = image.naturalWidth;
      const ih = image.naturalHeight;
      const mobilePlacement = isMobile
        ? computeMobileHeroAssetPlacement({
            canvasWidth: cw,
            canvasHeight: ch,
            naturalWidth: iw,
            naturalHeight: ih,
          })
        : null;
      const scale = mobilePlacement?.scale ?? Math.max(cw / iw, ch / ih) * 0.59;
      const width = mobilePlacement?.width ?? iw * scale;
      const height = mobilePlacement?.height ?? ih * scale;
      const destinationX = mobilePlacement?.x ?? (cw - width) / 2;
      const destinationY = mobilePlacement?.y ?? ch - height;
      renderedAsset = {
        key: selection?.key!,
        source: image.currentSrc || image.src,
        destination: { x: destinationX, y: destinationY, width, height },
        naturalWidth: iw,
        naturalHeight: ih,
      };
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.drawImage(image, destinationX, destinationY, width, height);
    }

    if (
      !isMobile &&
      noiseImage.complete &&
      noiseImage.naturalWidth > 0 &&
      noiseImage.naturalHeight > 0
    ) {
      context.globalAlpha = 0.88;
      context.globalCompositeOperation = "multiply";
      context.drawImage(noiseImage, 0, 0, cw, ch);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  function updateOverlayPresentation(): void {
    const mobile = mobileGeometry.mobile;
    const presentation = mobile
      ? sampleMobileHeroPresentation({
          phase,
          targetFrame,
          reducedMotion,
          ctaAvailable,
          playbackCompleted,
        })
      : null;
    const roleOpacity = reducedMotion
      ? 1
      : mobile
        ? presentation!.roleOpacity
        : frameOpacity(displayFrame, 5, 14, 125, 145);
    const experienceOpacity = reducedMotion
      ? 1
      : mobile
        ? presentation!.experienceOpacity
        : frameOpacity(displayFrame, 18, 28, 128, 145);
    const cta = sampleHeroCTA({
      phase,
      targetFrame,
      reducedMotion,
      latched: ctaAvailable,
    });
    if (cta.available) ctaAvailable = true;

    elements.st1.style.opacity = String(clamp(roleOpacity, 0, 1));
    elements.st2.style.opacity = String(clamp(experienceOpacity, 0, 1));
    elements.exploreCTA.style.opacity = String(cta.opacity);
    elements.exploreCTA.style.pointerEvents = cta.pointerEvents;
    if (!reducedMotion && (phase === "ready" || phase === "complete")) {
      removeClass(elements.hint, "gone");
    } else {
      addClass(elements.hint, "gone");
    }
  }

  function render(): void {
    updateOverlayPresentation();
    draw(displayFrame);
  }

  function pointerTarget(): number {
    const drift = (pointerYNormalized - 0.5) * 2 * HERO_DRIFT_FRAMES;
    if (phase === "ready") {
      return clamp(
        HERO_CONTRACT.introEndFrame + drift,
        HERO_CONTRACT.introEndFrame - HERO_DRIFT_FRAMES,
        HERO_CONTRACT.introEndFrame + HERO_DRIFT_FRAMES,
      );
    }
    if (phase === "complete" || phase === "exit-hold") {
      return clamp(
        HERO_CONTRACT.endFrame - HERO_DRIFT_FRAMES + drift,
        HERO_CONTRACT.endFrame - HERO_DRIFT_FRAMES * 2,
        HERO_CONTRACT.endFrame,
      );
    }
    return targetFrame;
  }

  function nativeTargetFrameForPhase(): number {
    if (phase === "intro" || phase === "playing") return displayFrame;
    if (phase === "ready") return pointerTarget();
    return HERO_NATIVE_END_FRAME;
  }

  function syncNativePlayback(): void {
    const video = nativeVideo;
    if (!video || !nativeVisible || nativeStopped || rendererActive === "c") return;
    const target = clamp(nativeTargetFrameForPhase(), 0, HERO_NATIVE_END_FRAME);
    const targetSeconds = nativeFrameToSeconds(target);
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const phaseChanged = nativePlaybackPhase !== phase;
    if (phase === "intro" || phase === "playing") {
      nativePlaybackPhase = phase;
      video.playbackRate = phase === "intro" ? nativeIntroPlaybackRate() : nativeMainPlaybackRate();
      // Let the native decoder play continuously; correct only a visible
      // drift so rVFC/timeupdate remain close to the contract's target frame.
      if (phaseChanged || Math.abs(currentTime - targetSeconds) > 0.2) {
        video.currentTime = targetSeconds;
        updateNativePresentedFrame(targetSeconds);
      }
      if (video.paused) {
        void video.play().catch((error: unknown) => {
          failNativeCandidate(`native ${rendererActive.toUpperCase()} playback failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return;
    }

    nativePlaybackPhase = phase;
    video.pause();
    if (phase === "ready" || phase === "complete" || phase === "exit-hold" || phase === "released" || phase === "reduced") {
      if (phaseChanged || Math.abs(currentTime - targetSeconds) > 0.02) {
        video.currentTime = targetSeconds;
        updateNativePresentedFrame(targetSeconds);
      }
    }
  }

  function onFrame(timestampMs: number, deltaMs: number): boolean {
    if (disposed || reducedMotion || !isVisible) return false;
    const elapsed = Math.max(0, finiteOr(deltaMs, 0));

    if (phase === "intro" || phase === "playing") {
      if (phaseStartTime === null) phaseStartTime = timestampMs - phaseElapsedMs;
      phaseElapsedMs += elapsed;
      // Calling the pure timeline sampler through the contract keeps elapsed
      // time independent of the scheduler's refresh rate.
      const sample = phase === "intro"
        ? sampleHeroTimeline("intro", phaseElapsedMs)
        : sampleHeroTimeline("playing", phaseElapsedMs);
      targetFrame = sample.targetFrame;
      if (phase === "intro" && sample.progress >= 1) {
        targetFrame = HERO_CONTRACT.introEndFrame;
        transition("intro-complete", "intro timeline complete");
      } else if (phase === "playing" && sample.progress >= 1) {
        targetFrame = HERO_CONTRACT.endFrame;
        playbackCompleted = true;
        transition("playback-complete", "playback timeline complete");
      }
    } else if (phase === "ready" || phase === "complete" || phase === "exit-hold") {
      targetFrame = pointerTarget();
    } else {
      targetFrame = HERO_CONTRACT.endFrame;
    }

    const interpolation =
      phase === "intro" ||
      phase === "playing" ||
      phase === "ready" ||
      phase === "complete" ||
      phase === "exit-hold";
    if (interpolation) displayFrame = smoothHeroFrame(displayFrame, targetFrame, elapsed);
    else displayFrame = targetFrame;
    if (Math.abs(displayFrame - targetFrame) < 0.02) displayFrame = targetFrame;
    render();
    syncNativePlayback();

    if (phase === "intro" || phase === "playing" || phase === "exit-hold") return true;
    return Math.abs(displayFrame - targetFrame) >= 0.02;
  }

  function advanceFromReady(reason: string): void {
    if (phase !== "ready") return;
    transition("advance", reason);
    activateScene();
  }

  function releaseHero(reason: string): void {
    clearReadinessTimer();
    if (exitHoldTimer !== null) {
      timerApi.clearTimeout(exitHoldTimer);
      exitHoldTimer = null;
    }
    if (phase === "reduced") return;
    if (phase === "released") {
      if (pendingNativeHandoff) stopNativeCandidate();
      deactivateScene();
      render();
      return;
    }
    transition("release", reason);
    deactivateScene();
    render();
    if (pendingNativeHandoff) stopNativeCandidate();
    // There may be no next scheduler tick after direct navigation. Explicitly
    // move a visible native candidate to its terminal, paused state so media
    // cannot continue playing after the hero has been released.
    syncNativePlayback();
  }

  function goToAbout(reason: string): void {
    if (phase !== "complete") return;
    transition("request-exit", reason);
    activateScene();
    exitHoldTimer = timerApi.setTimeout(() => {
      exitHoldTimer = null;
      if (disposed || phase !== "exit-hold") return;
      transition("exit-delay-complete", "exit hold elapsed");
      releaseHero("exit delay complete");
      const about = browserDocument.getElementById("about");
      if (about) browserWindow.scrollTo({ top: about.offsetTop, behavior: reducedMotion ? "auto" : "smooth" });
    }, HERO_EXIT_HOLD_MS);
  }

  function currentMobileInputDisposition(): "consume" | "native-next-gesture" {
    return mobileHeroInputDisposition({
      mobile: mobileGeometry.mobile,
      phase,
      targetFrame,
      reducedMotion,
      nativePreparationPending: nativePreparationTimer !== null,
      readinessWatchdogPending: readinessTimer !== null,
      hasRenderableFrame: phase !== "loading" && hasRenderableHeroFrame(),
    });
  }

  function onWheel(event: WheelEvent): void {
    if (disposed || reducedMotion || !isVisible || event.deltaY <= 0) return;
    // Mobile owns the downward input until the semantic copy transition.
    // This includes loading and intro: allowing native scrolling there would
    // release the hero before it has established its first-screen state. At
    // frame 58 the current event is simply left native; touch browsers cannot
    // retroactively release an earlier, already-prevented gesture.
    if (
      mobileGeometry.mobile &&
      currentMobileInputDisposition() === "consume"
    ) {
      event.preventDefault();
      if (phase === "ready") advanceFromReady("wheel-down");
      else if (phase === "complete") goToAbout("wheel-down");
      return;
    }
    if (phase !== "ready" && phase !== "complete") return;
    event.preventDefault();
    if (phase === "ready") advanceFromReady("wheel-down");
    else goToAbout("wheel-down");
  }

  function onTouchStart(event: TouchEvent): void {
    if (disposed || reducedMotion || !isVisible) {
      touchStartY = null;
      return;
    }
    const touch = event.touches[0];
    if (touch) touchStartY = touch.clientY;
  }

  function onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!touch || disposed || reducedMotion || !isVisible) return;
    pointerYNormalized = clamp(touch.clientY / Math.max(1, browserWindow.innerHeight), 0, 1);
    if (touchStartY === null) touchStartY = touch.clientY;
    const delta = touchStartY - touch.clientY;
    if (
      mobileGeometry.mobile &&
      delta > 0 &&
      currentMobileInputDisposition() === "consume"
    ) {
      event.preventDefault();
    }
    if (delta < 30 || (phase !== "ready" && phase !== "complete")) return;
    touchStartY = touch.clientY;
    if (phase === "ready") advanceFromReady("touch-up");
    else goToAbout("touch-up");
  }

  function onTouchEnd(): void {
    touchStartY = null;
  }

  function onMouseMove(event: MouseEvent): void {
    pointerYNormalized = clamp(event.clientY / Math.max(1, browserWindow.innerHeight), 0, 1);
    if (phase === "ready" || phase === "complete") activateScene();
  }

  function scheduleGeometryResync(): void {
    if (disposed || geometrySettleTimer !== null) return;
    // Resize can be delivered before the browser commits its new layout box
    // (notably during iOS visual-viewport toolbar transitions). One bounded
    // next-task sample closes that race even where ResizeObserver is absent;
    // repeated resize events are coalesced into the same sample.
    geometrySettleTimer = timerApi.setTimeout(() => {
      geometrySettleTimer = null;
      if (disposed) return;
      syncGeometry(false);
      ensureNoiseLoaded();
      render();
    }, 0);
  }

  function onResize(): void {
    syncGeometry(false);
    ensureNoiseLoaded();
    render();
    scheduleGeometryResync();
  }

  function onOrientationChange(): void {
    syncGeometry(true);
    ensureNoiseLoaded();
    render();
    scheduleGeometryResync();
  }

  function onDirectNavigation(): void {
    releaseHero("direct navigation");
  }

  function onReducedMotionChange(next: boolean): void {
    if (disposed || reducedMotion === next) return;
    reducedMotion = next;
    if (next) {
      // A native candidate remains hidden until readiness, and a visible
      // candidate must be torn down when motion is disabled. On re-enable the
      // same capability ladder is evaluated again; this avoids leaving a
      // stopped video as an accidental second renderer.
      if (rendererActive !== "c" || pendingNativeHandoff !== null) {
        stopNativeCandidate();
        rendererActive = "c";
        rendererPreparation = "idle";
        cRendererStarted = false;
      }
      // Entering reduced motion is an interruption, not a second animation
      // path.  A pending exit hold must not later scroll the page after the
      // preference has already settled the hero.
      if (exitHoldTimer !== null) {
        timerApi.clearTimeout(exitHoldTimer);
        exitHoldTimer = null;
      }
      transition("reduced-motion", "prefers-reduced-motion");
      render();
      return;
    }

    const priorPhase = phaseBeforeReducedMotion;
    // A reduced-motion toggle while the hero is already terminal (or while
    // it is offscreen) must not replay the intro when motion is allowed again.
    // Keep the released state as the durable navigation boundary.
    if (priorPhase === "released" || (priorPhase !== null && !isVisible)) {
      setPhase("released", "reduced-motion-off", "preserve released/offscreen hero");
      targetFrame = HERO_CONTRACT.endFrame;
      displayFrame = HERO_CONTRACT.endFrame;
      ctaAvailable = true;
      deactivateScene();
      render();
      return;
    }
    // A completed hero remains complete after a preference toggle.  This
    // keeps its CTA available without replaying the timeline.
    if (priorPhase === "complete" || priorPhase === "exit-hold") {
      setPhase("complete", "reduced-motion-off", "preserve completed hero");
      targetFrame = HERO_CONTRACT.endFrame;
      displayFrame = HERO_CONTRACT.endFrame;
      ctaAvailable = true;
      deactivateScene();
      render();
      return;
    }

    // For a non-terminal preference toggle, re-enter through the loading/
    // intro policy with the already-known asset state.
    phase = registry.introReady ? "intro" : "loading";
    phaseBeforeReducedMotion = null;
    phaseElapsedMs = 0;
    phaseStartTime = null;
    targetFrame = registry.introReady ? HERO_CONTRACT.startFrame : HERO_CONTRACT.startFrame;
    displayFrame = targetFrame;
    ctaAvailable = false;
    if (registry.introReady) activateScene();
    // Reduced motion deliberately pauses the progressive image queue. Resume
    // the same cursors when motion is enabled again so a partially loaded
    // intro cannot strand the scene in loading until the watchdog fires.
    if (!cRendererStarted) initializeRenderer();
    else pumpImageQueue();
    render();
    if (phase === "loading") armReadinessWatchdog();
  }

  function observeVisibility(): void {
    const observerConstructor = (
      browserWindow as Window & { IntersectionObserver?: typeof IntersectionObserver }
    ).IntersectionObserver;
    if (typeof observerConstructor !== "function") return;
    const observer = new observerConstructor((entries: IntersectionObserverEntry[]) => {
      const entry = entries[0];
      isVisible = entry?.isIntersecting ?? true;
      if (!isVisible) {
        deactivateScene();
        // Intersection lifecycle pauses native playback immediately. The
        // shared scheduler may have no runnable hero tick while offscreen, so
        // waiting for syncNativePlayback() would let the video run ahead of
        // the contract timeline.
        nativeVideo?.pause();
        recordEvent("intersection", phase, phase, "hero offscreen");
      } else if (phase === "intro" || phase === "playing" || phase === "exit-hold") {
        activateScene();
        syncNativePlayback();
        recordEvent("intersection", phase, phase, "hero onscreen");
      }
    });
    observer.observe(elements.scrolly);
    listeners.push(() => observer.disconnect());
  }

  function observeLayoutResize(): void {
    const observerConstructor = (
      browserWindow as Window & { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver ?? (typeof ResizeObserver === "function" ? ResizeObserver : undefined);
    if (typeof observerConstructor !== "function") return;
    const observer = new observerConstructor(() => {
      syncGeometry(false);
      ensureNoiseLoaded();
      render();
    });
    observer.observe(browserDocument.documentElement);
    observer.observe(elements.scrolly);
    listeners.push(() => observer.disconnect());
  }

  function listen<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    optionsArg?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, optionsArg);
    listeners.push(() => target.removeEventListener(type, listener as EventListener, optionsArg));
  }

  syncGeometry(true);
  ensureNoiseLoaded();

  listen(browserWindow, "resize", onResize);
  listen(browserWindow, "orientationchange", onOrientationChange);
  const visualViewport = browserWindow.visualViewport;
  if (visualViewport) {
    visualViewport.addEventListener("resize", onResize);
    listeners.push(() => visualViewport.removeEventListener("resize", onResize));
  }
  listen(browserWindow, "mousemove", onMouseMove);
  listen(browserWindow, "wheel", onWheel, { passive: false });
  listen(browserWindow, "touchstart", onTouchStart, { passive: true });
  listen(browserWindow, "touchmove", onTouchMove, { passive: false });
  listen(browserWindow, "touchend", onTouchEnd, { passive: true });
  browserDocument.querySelectorAll("nav a").forEach((link) => {
    link.addEventListener("click", onDirectNavigation);
    listeners.push(() => link.removeEventListener("click", onDirectNavigation));
  });
  elements.exploreCTA.addEventListener("click", onDirectNavigation);
  listeners.push(() => elements.exploreCTA.removeEventListener("click", onDirectNavigation));
  observeVisibility();
  observeLayoutResize();

  if (options.onReducedMotionChange) {
    listeners.push(options.onReducedMotionChange(onReducedMotionChange));
  } else if (query) {
    const mediaListener = (event: MediaQueryListEvent) => onReducedMotionChange(event.matches);
    if (supportsMediaListener(query)) {
      query.addEventListener("change", mediaListener);
      listeners.push(() => query.removeEventListener("change", mediaListener));
    } else {
      query.addListener(mediaListener);
      listeners.push(() => query.removeListener(mediaListener));
    }
  }

  updateLoader();
  if (reducedMotion) {
    addClass(elements.loader, "hidden");
    render();
  } else if (disabled) {
    addClass(elements.loader, "hidden");
    deactivateScene();
    render();
  } else {
    initializeRenderer();
    // Native preparation owns the frame-0 poster and its own deadline. C
    // starts its progressive queue only when selected or after native failure.
    if (rendererActive === "c") {
      beginIntroIfReady("assets already ready");
      armReadinessWatchdog();
    }
  }

  function snapshot(): HeroSceneSnapshot {
    const readiness = registry.diagnostics();
    const rect = canvasRect();
    const schedulerState = scheduler.diagnostics();
    const cta = sampleHeroCTA({ phase, targetFrame, reducedMotion, latched: ctaAvailable });
    const mobilePresentation = mobileGeometry.mobile
      ? sampleMobileHeroPresentation({
          phase,
          targetFrame,
          reducedMotion,
          ctaAvailable,
          playbackCompleted,
        })
      : null;
    return {
      phase,
      // `activeScenes` is the scheduler's runnable set.  The requested
      // registration set can remain active while hidden/reduced/disposed
      // policy has correctly made the scene non-runnable.
      active: schedulerState.activeScenes.includes(sceneName),
      autoplay: !reducedMotion && (phase === "intro" || phase === "playing"),
      reducedMotion,
      exitHoldPending: exitHoldTimer !== null,
      readinessWatchdogPending: readinessTimer !== null,
      phaseStartTime,
      phaseElapsedMs,
      playbackCompleted,
      targetFrame,
      displayFrame,
      renderedFrame: clamp(Math.round(displayFrame), HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame),
      pointerYNormalized,
      geometry: {
        stableHeight: stableHeight ?? 0,
        boundary: mobileGeometry.boundary,
        stageTop: mobileGeometry.stageTop,
        stageHeight: mobileGeometry.stageHeight,
        mobile: mobileGeometry.mobile,
        effectiveDpr: mobileGeometry.effectiveDpr,
      },
      assets: {
        requested: imageRequestCount,
        activeRequests: activeImageLoads,
        introRequestCountAtReady,
        laterQueueStarted,
        loaded: readiness.ready + readiness.failed,
        expected: readiness.expected,
        introReady: readiness.introReady,
        allReady: readiness.allReady,
        pending: readiness.pending,
        failed: readiness.failed,
        degraded: readiness.degraded,
        fallbackCount: readiness.fallbackCount,
        lastFrameSelection: readiness.lastFrameSelection,
        failedAssets: readiness.failedAssets,
        readiness,
      },
      overlays: {
        roleOpacity: mobilePresentation?.roleOpacity ?? readOpacity(elements.st1),
        experienceOpacity: mobilePresentation?.experienceOpacity ?? readOpacity(elements.st2),
        cue: mobilePresentation?.cue ?? (cta.available ? "cta" : null),
        ctaAvailable: cta.available,
        ctaOpacity: cta.opacity,
        ctaPointerEvents: cta.pointerEvents,
      },
      canvas: {
        cssWidth: Math.max(0, rect.width),
        cssHeight: Math.max(0, rect.height),
        backingWidth: elements.canvas.width,
        backingHeight: elements.canvas.height,
        renderedAsset,
      },
      renderer: {
        requested: rendererRequested,
        active: rendererActive,
        selection: rendererSelection,
        presentedFrame: pendingNativeHandoff
          ? nativePresentedFrame
          : rendererActive === "c"
            ? clamp(Math.round(displayFrame), HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame)
            : nativePresentedFrame,
        visible: nativeVisible,
        preparation: rendererPreparation,
        fallback: rendererFallback,
        source: nativeSource,
        assetId: nativeVideo?.dataset.assetId ?? null,
      },
      events: events.map((event) => ({ ...event })),
    };
  }

  if (diagnostics) diagnostics.register(sceneName, snapshot);

  const handle: HeroSceneHandle = {
    scene,
    registry,
    get phase(): HeroPhase {
      return phase;
    },
    snapshot,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (readinessTimer !== null) {
        timerApi.clearTimeout(readinessTimer);
        readinessTimer = null;
      }
      if (geometrySettleTimer !== null) {
        timerApi.clearTimeout(geometrySettleTimer);
        geometrySettleTimer = null;
      }
      if (exitHoldTimer !== null) {
        timerApi.clearTimeout(exitHoldTimer);
        exitHoldTimer = null;
      }
      stopNativeCandidate();
      listeners.splice(0).forEach((remove) => remove());
      diagnostics?.unregister?.(sceneName);
      images.forEach((image) => {
        image.onload = null;
        image.onerror = null;
      });
      try {
        scene.unregister();
      } catch {
        // The parent scheduler may already be disposed; cleanup is idempotent.
      }
    },
  };

  return handle;
}

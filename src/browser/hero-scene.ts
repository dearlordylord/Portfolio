import {
  HERO_CONTRACT,
  HERO_LAYOUT_CONTRACT,
  computeHeroLayout,
  sampleHeroCTA,
  sampleHeroTimeline,
  sampleMobileHeroPresentation,
  smoothHeroFrame,
  transitionHeroPhase,
  type HeroPhase,
} from "../motion/hero-contract";
import {
  AssetReadinessRegistry,
  type AssetReadinessDiagnostics,
  type IntroReadinessPolicy,
} from "../motion/asset-fallback";
import {
  MotionScheduler,
  type MotionSchedulerScene,
} from "../motion/scheduler";

const HERO_BREAKPOINT = HERO_LAYOUT_CONTRACT.breakpoint;
const HERO_DRIFT_FRAMES = HERO_CONTRACT.driftFrames;
const HERO_EXIT_HOLD_MS = HERO_CONTRACT.exitHoldDurationMs;
const DEFAULT_IMAGE_PREFIX = "Кадры/frame_";
const DEFAULT_IMAGE_SUFFIX = "_delay-0.067s.webp";
const DEFAULT_NOISE_SOURCE = "Кадры/ШУМ.png";
const DEFAULT_HERO_BACKGROUND = "#edeef6";
const MAX_DIAGNOSTIC_EVENTS = 128;

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
  | "scroll-hint";

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
};

export type HeroSceneSnapshot = {
  phase: HeroPhase;
  active: boolean;
  autoplay: boolean;
  reducedMotion: boolean;
  exitHoldPending: boolean;
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
  // This is deliberately distinct from `phase`: a direct navigation can
  // release an in-progress hero, while only a completed playback earns the
  // durable terminal experience copy.
  let playbackCompleted = false;
  let pointerYNormalized = 0.5;
  let ctaAvailable = reducedMotion;
  let exitHoldTimer: TimerHandle | null = null;
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

  function ensureNoiseLoaded(): void {
    if (noiseRequested || mobileGeometry.mobile) return;
    noiseRequested = true;
    noiseImage.src = options.noiseSource ?? DEFAULT_NOISE_SOURCE;
  }

  function syncGeometry(force: boolean): void {
    // Size the backing store from the canvas' layout viewport, not innerWidth:
    // desktop scrollbar gutters can otherwise make the bitmap wider than its
    // CSS box and introduce a subtle horizontal squeeze.
    const width = Math.max(
      1,
      finiteOr(browserDocument.documentElement.clientWidth || browserWindow.innerWidth, 1),
    );
    const mobile = width <= HERO_BREAKPOINT;
    const orientationChanged = lastMobile !== null && lastMobile !== mobile;
    if (force || orientationChanged || stableHeight === null || !mobile) {
      stableHeight = Math.max(1, finiteOr(browserWindow.innerHeight, 1));
    }
    lastMobile = mobile;
    const visualHeight = Math.max(
      1,
      finiteOr(browserWindow.visualViewport?.height ?? browserWindow.innerHeight, stableHeight),
    );
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
  }

  function beginIntroIfReady(reason: string): void {
    if (disposed || disabled || reducedMotion || phase !== "loading" || !registry.introReady) return;
    addClass(elements.loader, "hidden");
    transition("assets-ready", reason);
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
    imageSettled.add(key);
    registry.markReady(key);
    updateLoader();
    recordEvent("asset-ready", "asset", "ready", key);
    beginIntroIfReady("intro assets ready");
    if (reducedMotion) draw(displayFrame);
  }

  function markImageFailed(key: string, error: unknown, code = "image-load-failed"): void {
    if (disposed || imageSettled.has(key)) return;
    imageSettled.add(key);
    const message = error instanceof Error ? error.message : String(error || "image failed");
    registry.markFailed(key, { code, message });
    updateLoader();
    recordEvent("asset-failed", "asset", "failed", `${key}: ${message}`);
    beginIntroIfReady("intro assets ready with named failures");
    if (reducedMotion) draw(displayFrame);
  }

  function loadImage(index: number): void {
    const key = `frame-${padFrame(index)}`;
    let image: HTMLImageElement;
    try {
      image = imageFactory();
    } catch (error) {
      markImageFailed(key, error, "image-factory-failed");
      return;
    }
    images.set(key, image);
    image.onload = () => {
      // Decode is best effort but a decoder rejection must remain visible as a
      // named registry failure rather than silently painting a broken frame.
      if (typeof image.decode !== "function") {
        markImageReady(key);
        return;
      }
      try {
        image.decode().then(
          () => markImageReady(key),
          (error: unknown) => markImageFailed(key, error, "decode-failed"),
        );
      } catch (error) {
        markImageFailed(key, error, "decode-failed");
      }
    };
    image.onerror = (error) => markImageFailed(key, error, "network-failed");
    image.src = options.imageSource?.(index) ?? `${DEFAULT_IMAGE_PREFIX}${padFrame(index)}${DEFAULT_IMAGE_SUFFIX}`;
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
    const selection = registry.selectFrame(clamp(requestedFrame, HERO_CONTRACT.startFrame, HERO_CONTRACT.endFrame));
    const image = selection.key ? images.get(selection.key) : undefined;
    const validImage = image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    const isMobile = mobileGeometry.mobile;

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

    if (validImage) {
      const iw = image.naturalWidth;
      const ih = image.naturalHeight;
      const scale = Math.max(cw / iw, ch / ih) * (isMobile ? 0.55 : 0.59);
      const width = iw * scale;
      const height = ih * scale;
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.drawImage(image, (cw - width) / 2, ch - height, width, height);
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

    if (phase === "intro" || phase === "playing" || phase === "exit-hold") return true;
    return Math.abs(displayFrame - targetFrame) >= 0.02;
  }

  function advanceFromReady(reason: string): void {
    if (phase !== "ready") return;
    transition("advance", reason);
    activateScene();
  }

  function releaseHero(reason: string): void {
    if (exitHoldTimer !== null) {
      timerApi.clearTimeout(exitHoldTimer);
      exitHoldTimer = null;
    }
    if (phase === "reduced") return;
    if (phase === "released") {
      deactivateScene();
      render();
      return;
    }
    transition("release", reason);
    deactivateScene();
    render();
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

  function onWheel(event: WheelEvent): void {
    if (disposed || reducedMotion || !isVisible || event.deltaY <= 0) return;
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

  function onResize(): void {
    syncGeometry(false);
    ensureNoiseLoaded();
    render();
  }

  function onOrientationChange(): void {
    syncGeometry(true);
    ensureNoiseLoaded();
    render();
  }

  function onDirectNavigation(): void {
    releaseHero("direct navigation");
  }

  function onReducedMotionChange(next: boolean): void {
    if (disposed || reducedMotion === next) return;
    reducedMotion = next;
    if (next) {
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
    render();
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
        recordEvent("intersection", phase, phase, "hero offscreen");
      } else if (phase === "intro" || phase === "playing" || phase === "exit-hold") {
        activateScene();
        recordEvent("intersection", phase, phase, "hero onscreen");
      }
    });
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
  for (let index = 0; index < HERO_CONTRACT.totalFrameCount; index += 1) loadImage(index);

  listen(browserWindow, "resize", onResize);
  listen(browserWindow, "orientationchange", onOrientationChange);
  listen(browserWindow, "mousemove", onMouseMove);
  listen(browserWindow, "wheel", onWheel, { passive: false });
  listen(browserWindow, "touchstart", onTouchStart, { passive: true });
  listen(browserWindow, "touchmove", onTouchMove, { passive: true });
  listen(browserWindow, "touchend", onTouchEnd, { passive: true });
  browserDocument.querySelectorAll("nav a").forEach((link) => {
    link.addEventListener("click", onDirectNavigation);
    listeners.push(() => link.removeEventListener("click", onDirectNavigation));
  });
  elements.exploreCTA.addEventListener("click", onDirectNavigation);
  listeners.push(() => elements.exploreCTA.removeEventListener("click", onDirectNavigation));
  observeVisibility();

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
    beginIntroIfReady("assets already ready");
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
      if (exitHoldTimer !== null) {
        timerApi.clearTimeout(exitHoldTimer);
        exitHoldTimer = null;
      }
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

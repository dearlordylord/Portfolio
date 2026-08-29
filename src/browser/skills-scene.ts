import {
  AssetReadinessRegistry,
  type AssetFailure,
  type AssetReadinessDiagnostics,
} from "../motion/asset-fallback";
import {
  SKILL_DEFINITIONS,
  SKILLS_BREAKPOINT,
  SkillsSimulation,
  type SkillDefinition,
  type SkillsSnapshot,
} from "../motion/skills-model";
import {
  MotionScheduler,
  type MotionSchedulerScene,
} from "../motion/scheduler";

/** The narrow diagnostics surface used by the page's optional inspection API. */
export type SkillsDiagnosticsPort = {
  register(name: string, reader: () => unknown): void;
  unregister?(name: string): void;
};

/** The shared reduced-motion lifecycle supplied by the page entry point. */
export type SkillsReducedMotionRegistrar = (
  listener: (reducedMotion: boolean) => void,
) => () => void;

/**
 * A constructor-shaped dependency is useful in browser tests, where the
 * native IntersectionObserver may not be installed.  Production callers can
 * omit it and the adapter uses the document's native constructor.
 */
export type SkillsIntersectionObserverConstructor = new (
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) => IntersectionObserver;

export type SkillsImageFactory = () => HTMLImageElement | null;

export type SkillsSceneOptions = Readonly<{
  /** The shared lifecycle owner. It is deliberately injected, never created per frame. */
  scheduler: MotionScheduler;
  /** Defaults to the existing #skillcanvas in the supplied/owner document. */
  canvas?: HTMLCanvasElement | null;
  /** Optional localhost-only inspection port. */
  diagnostics?: SkillsDiagnosticsPort;
  /** Defaults to the canvas owner document, then the ambient browser document. */
  document?: Document;
  /** Defaults to the canvas owner window, then the ambient browser window. */
  window?: Window;
  /** Stable scene key used by diagnostics and scheduler metrics. */
  sceneName?: string;
  /** Explicit policy override; otherwise matchMedia is consulted when available. */
  reducedMotion?: boolean;
  /** Lifecycle-owned reduced-motion listener, when available. */
  onReducedMotionChange?: SkillsReducedMotionRegistrar;
  /** Disable this scene while retaining a named, inspectable registration. */
  disabled?: boolean;
  /** Optional model/registry seams keep the adapter deterministic and testable. */
  model?: SkillsSimulation;
  assetRegistry?: AssetReadinessRegistry;
  imageFactory?: SkillsImageFactory;
  intersectionObserver?: SkillsIntersectionObserverConstructor;
  /** The existing scene uses a 440px mobile and 520px desktop canvas. */
  mobileHeight?: number;
  desktopHeight?: number;
  /** Optional fixed measurement overrides, primarily useful for embedded scenes. */
  width?: number;
  height?: number;
  /** Defaults to the canonical skill manifest in skills-model.ts. */
  manifest?: readonly SkillDefinition[];
}>;

export type SkillsSceneDiagnostics = {
  started: boolean;
  visible: boolean;
  active: boolean;
  reducedMotion: boolean;
  mobileModel: boolean;
  seed: number;
  width: number;
  height: number;
  phase: SkillsSnapshot["phase"];
  simulationMs: number;
  needsFrame: boolean;
  expectedIcons: number;
  iconAssetsLoaded: number;
  iconAssetsPending: string[];
  iconAssetsFailed: string[];
  assetReadiness: AssetReadinessDiagnostics;
  /** Kept as an alias for existing diagnostics consumers. */
  assets: AssetReadinessDiagnostics;
  contextAvailable: boolean;
  disabled: boolean;
  reason: "disabled-for-scene-isolation" | "reduced-motion" | "idle" | "running";
  chips: Array<{
    index: number;
    label: string;
    svg: string;
    r: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    targetX: number;
    targetY: number;
  }>;
};

export type SkillsSceneHandle = {
  readonly canvas: HTMLCanvasElement;
  readonly model: SkillsSimulation;
  readonly simulation: SkillsSimulation;
  readonly assetRegistry: AssetReadinessRegistry;
  readonly assets: AssetReadinessRegistry;
  readonly scene: MotionSchedulerScene;
  start(): void;
  pause(): void;
  resume(): void;
  resize(): void;
  snapshot(): SkillsSnapshot;
  diagnostics(): SkillsSceneDiagnostics;
  destroy(): void;
};

type ImageWithDecode = HTMLImageElement & {
  decode?: () => Promise<void>;
};

type ListenerTarget = {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void;
};

const DEFAULT_MOBILE_HEIGHT = 440;
const DEFAULT_DESKTOP_HEIGHT = 520;
const MAX_DPR = 2;
const ICON_FAILURE_CODE = "icon-load-error";
const ICON_CONSTRUCTOR_FAILURE_CODE = "image-constructor-unavailable";

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function errorDetails(error: unknown): AssetFailure {
  if (error instanceof Error) {
    return { code: ICON_FAILURE_CODE, message: error.message };
  }
  if (typeof error === "string" && error.trim() !== "") {
    return { code: ICON_FAILURE_CODE, message: error };
  }
  return { code: ICON_FAILURE_CODE };
}

function ambientDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function ambientWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function readCssPixels(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return positiveFinite(parsed) ? parsed : undefined;
}

function eventListenerTarget(value: unknown): value is ListenerTarget {
  return Boolean(
    value &&
      typeof (value as ListenerTarget).addEventListener === "function" &&
      typeof (value as ListenerTarget).removeEventListener === "function",
  );
}

/**
 * Mounts the Tools & Skills canvas as a shallow browser adapter.
 *
 * The adapter intentionally does not contain physics.  It translates browser
 * events into SkillsSimulation calls, paints immutable snapshots, and lets
 * MotionScheduler own requestAnimationFrame.  A missing canvas is a valid
 * no-op for pages that render the section conditionally.
 */
export function mountSkillsScene(options: SkillsSceneOptions): SkillsSceneHandle | null {
  const scheduler = options.scheduler;
  if (!scheduler) throw new TypeError("mountSkillsScene requires a MotionScheduler");

  const suppliedCanvas = options.canvas;
  const ownerDocument =
    options.document ?? suppliedCanvas?.ownerDocument ?? ambientDocument();
  const canvas = suppliedCanvas ?? ownerDocument?.getElementById("skillcanvas");
  if (!isCanvasLike(canvas)) return null;

  // The structural HTML element is still a real canvas in production.  The
  // small guard keeps the adapter usable with minimal DOM doubles in tests.
  const skillCanvas = canvas as HTMLCanvasElement;
  const ownerWindow = options.window ?? ownerDocument?.defaultView ?? ambientWindow();
  const sceneName = options.sceneName ?? "skills";
  const manifest = options.manifest ?? SKILL_DEFINITIONS;
  const mobileHeight = options.mobileHeight ?? DEFAULT_MOBILE_HEIGHT;
  const desktopHeight = options.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT;

  if (!positiveFinite(mobileHeight) || !positiveFinite(desktopHeight)) {
    throw new RangeError("Skills canvas heights must be finite positive numbers");
  }
  if (options.width !== undefined && !positiveFinite(options.width)) {
    throw new RangeError("Skills canvas width must be a finite positive number");
  }
  if (options.height !== undefined && !positiveFinite(options.height)) {
    throw new RangeError("Skills canvas height must be a finite positive number");
  }

  const context = getCanvasContext(skillCanvas);
  const images = new Map<string, HTMLImageElement>();
  const explicitlyReduced = options.reducedMotion !== undefined;
  // The page entry point owns the policy when a registrar is supplied.  Keep
  // the query only as a direct-consumer fallback so Skills cannot add a second
  // media-query listener or drift from the shared scheduler lifecycle.
  const mediaQuery =
    !explicitlyReduced && !options.onReducedMotionChange
      ? ownerWindow?.matchMedia?.("(prefers-reduced-motion: reduce)")
      : undefined;
  let reducedMotion =
    options.reducedMotion ??
    (options.onReducedMotionChange ? scheduler.reducedMotion : mediaQuery?.matches ?? scheduler.reducedMotion);
  const disabled = options.disabled === true;
  let visible = false;
  let started = false;
  let hidden = Boolean(ownerDocument?.hidden);
  let destroyed = false;
  let cssWidth = 1;
  let cssHeight = mobileHeight;
  let dpr = 1;
  let observer: IntersectionObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let scene: MotionSchedulerScene;
  let reducedMotionCleanup: (() => void) | null = null;

  const model = options.model ?? createInitialModel();
  const assetRegistry =
    options.assetRegistry ??
    new AssetReadinessRegistry(manifest.map((skill) => ({ key: skill.svg, phase: "optional" as const })));

  // A supplied model can come from a host that mounted it before this adapter.
  // Align its policy once at the browser boundary, while keeping scene
  // isolation separate from the user's reduced-motion preference.
  if (model.reducedMotion !== reducedMotion) {
    model.setReducedMotion(reducedMotion);
  }
  if (disabled && model.needsFrame) model.pause();

  function createInitialModel(): SkillsSimulation {
    const dimensions = measureCanvas();
    const mobile = dimensions.width <= SKILLS_BREAKPOINT;
    return new SkillsSimulation({
      width: dimensions.width,
      height: dimensions.height,
      mobile,
      reducedMotion,
      autoStart: false,
    });
  }

  function getComputedStyleSafe(): CSSStyleDeclaration | undefined {
    try {
      return ownerWindow?.getComputedStyle(skillCanvas);
    } catch {
      return undefined;
    }
  }

  function measureWidth(): number {
    if (options.width !== undefined) return options.width;

    let measured: number | undefined;
    try {
      measured = skillCanvas.getBoundingClientRect().width;
    } catch {
      measured = undefined;
    }
    if (!positiveFinite(measured)) measured = positiveFinite(skillCanvas.clientWidth) ? skillCanvas.clientWidth : undefined;
    if (!positiveFinite(measured)) measured = positiveFinite(skillCanvas.offsetWidth) ? skillCanvas.offsetWidth : undefined;
    if (!positiveFinite(measured)) measured = readCssPixels(getComputedStyleSafe()?.width);
    if (!positiveFinite(measured)) measured = positiveFinite(ownerWindow?.innerWidth) ? ownerWindow!.innerWidth : undefined;
    if (!positiveFinite(measured)) measured = positiveFinite(skillCanvas.width) ? skillCanvas.width : undefined;
    return measured ?? 1;
  }

  function measureCanvas(): { width: number; height: number } {
    const width = measureWidth();
    const mobile = width <= SKILLS_BREAKPOINT;
    if (options.height !== undefined) return { width, height: options.height };
    if (mobile) return { width, height: mobileHeight };

    let measured: number | undefined;
    try {
      measured = skillCanvas.getBoundingClientRect().height;
    } catch {
      measured = undefined;
    }
    if (!positiveFinite(measured)) measured = positiveFinite(skillCanvas.clientHeight) ? skillCanvas.clientHeight : undefined;
    if (!positiveFinite(measured)) measured = positiveFinite(skillCanvas.offsetHeight) ? skillCanvas.offsetHeight : undefined;
    if (!positiveFinite(measured)) measured = readCssPixels(getComputedStyleSafe()?.height);
    return { width, height: measured ?? desktopHeight };
  }

  function applyCanvasSize(width: number, height: number): void {
    cssWidth = width;
    cssHeight = height;
    const devicePixelRatio = ownerWindow?.devicePixelRatio ?? 1;
    dpr = Math.min(Math.max(positiveFinite(devicePixelRatio) ? devicePixelRatio : 1, 1), MAX_DPR);
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));

    if (skillCanvas.width !== backingWidth) skillCanvas.width = backingWidth;
    if (skillCanvas.height !== backingHeight) skillCanvas.height = backingHeight;
    if (skillCanvas.style) {
      skillCanvas.style.width = `${width}px`;
      skillCanvas.style.height = `${height}px`;
    }

    if (context) {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function imageReady(image: HTMLImageElement): boolean {
    const naturalWidth = image.naturalWidth;
    return image.complete && (typeof naturalWidth !== "number" || naturalWidth > 0);
  }

  function markAssetReady(key: string, image: HTMLImageElement): void {
    if (destroyed) return;
    try {
      assetRegistry.markReady(key);
    } catch {
      return;
    }
    // onload is sufficient for normal SVGs.  decode adds an explicit decode
    // failure state where a browser exposes the promise, without delaying the
    // visible label fallback or initial paint.
    const decode = (image as ImageWithDecode).decode;
    if (typeof decode === "function") {
      try {
        const result = decode.call(image);
        if (result && typeof result.then === "function") {
          void result.catch((error: unknown) => {
            try {
              assetRegistry.markFailed(key, errorDetails(error));
            } catch {
              // A destroyed/injected registry is outside the renderer's control.
            }
            paint();
          });
        }
      } catch (error) {
        try {
          assetRegistry.markFailed(key, errorDetails(error));
        } catch {
          // A destroyed/injected registry is outside the renderer's control.
        }
      }
    }
    paint();
  }

  function markAssetFailed(key: string, error?: unknown): void {
    if (destroyed) return;
    try {
      assetRegistry.markFailed(key, error instanceof Error || typeof error === "string" ? errorDetails(error) : ICON_FAILURE_CODE);
    } catch {
      return;
    }
    paint();
  }

  function loadIcons(): void {
    const createImage = options.imageFactory ?? (() => {
      const ImageConstructor =
        (ownerWindow as (Window & { Image?: typeof Image }) | undefined)?.Image ??
        (typeof Image === "undefined" ? undefined : Image);
      return ImageConstructor ? new ImageConstructor() : null;
    });

    for (const skill of manifest) {
      const key = skill.svg;
      let image: HTMLImageElement | null;
      try {
        image = createImage();
      } catch (error) {
        image = null;
        markAssetFailed(key, { code: ICON_CONSTRUCTOR_FAILURE_CODE, message: String(error) });
      }

      if (!image) {
        markAssetFailed(key, ICON_CONSTRUCTOR_FAILURE_CODE);
        continue;
      }

      images.set(key, image);
      image.onload = () => markAssetReady(key, image!);
      image.onerror = (event) => markAssetFailed(key, event);
      try {
        image.src = key;
      } catch (error) {
        markAssetFailed(key, error);
        continue;
      }

      // Some test doubles and cached browser responses are complete before an
      // event listener can observe the load.  Do not classify a fresh image
      // with naturalWidth === 0 as failed; its onerror remains authoritative.
      if (imageReady(image)) markAssetReady(key, image);
    }
  }

  function iconCanBePainted(key: string, image: HTMLImageElement | undefined): boolean {
    return assetStatus(key) === "ready" && Boolean(image && imageReady(image));
  }

  function assetStatus(key: string): "pending" | "ready" | "failed" {
    try {
      return assetRegistry.status(key);
    } catch {
      return "failed";
    }
  }

  function drawChip(snapshot: SkillsSnapshot["chips"][number]): void {
    if (!context) return;
    const { x, y, r } = snapshot;

    // Match the original card-like visual: soft shadow, translucent white
    // gradient, shimmer overlay, and a crisp inset border.
    context.save();
    context.shadowColor = "rgba(120,100,180,0.10)";
    context.shadowBlur = 22;
    context.shadowOffsetY = 3;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fillStyle = "rgba(255,255,255,0.01)";
    context.fill();
    context.restore();

    context.save();
    const gradient = context.createLinearGradient(
      x - r * 0.707,
      y - r * 0.707,
      x + r * 0.707,
      y + r * 0.707,
    );
    gradient.addColorStop(0, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0.20)");
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fillStyle = gradient;
    context.fill();
    context.restore();

    context.save();
    const shimmer = context.createLinearGradient(
      x - r * 0.707,
      y - r * 0.707,
      x + r * 0.707,
      y + r * 0.707,
    );
    shimmer.addColorStop(0, "rgba(255,255,255,0.18)");
    shimmer.addColorStop(1, "rgba(255,255,255,0.04)");
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fillStyle = shimmer;
    context.fill();
    context.restore();

    context.save();
    context.beginPath();
    context.arc(x, y, r - 1, 0, Math.PI * 2);
    context.strokeStyle = "rgba(255,255,255,0.95)";
    context.lineWidth = 1.5;
    context.stroke();
    context.restore();

    const imageSize = Math.floor(r * 0.86);
    const labelSize = Math.max(9, Math.floor(r * 0.22));
    const gap = Math.floor(r * 0.09);
    const totalHeight = imageSize + gap + labelSize;
    const imageTop = y - totalHeight / 2;
    const labelCenterY = imageTop + imageSize + gap + labelSize * 0.5;
    const image = images.get(snapshot.svg);

    context.save();
    if (iconCanBePainted(snapshot.svg, image)) {
      try {
        context.drawImage(image!, x - imageSize / 2, imageTop, imageSize, imageSize);
      } catch (error) {
        // A decoder can become unusable between onload and drawImage. Keep the
        // skill label visible and surface the failure for diagnostics.
        markAssetFailed(snapshot.svg, error);
      }
    }
    // Labels are intentionally painted regardless of icon state. This is the
    // visible text fallback for late/missing SVGs and preserves M4 content.
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `600 ${labelSize}px Syne,system-ui,sans-serif`;
    context.fillStyle = "rgba(12,5,28,0.78)";
    context.fillText(snapshot.label, x, labelCenterY);
    context.restore();
  }

  function paint(snapshot = model.snapshot()): void {
    if (!context) return;
    try {
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      for (const chip of snapshot.chips) drawChip(chip);
      context.globalAlpha = 1;
    } catch {
      // A context can be lost during navigation. The model and diagnostics
      // remain valid, and the next resize/paint can recover if it returns.
    }
  }

  function pointerPosition(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    let rect: DOMRect;
    try {
      rect = skillCanvas.getBoundingClientRect();
    } catch {
      rect = { left: 0, top: 0 } as DOMRect;
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function activateIfNeeded(): void {
    // Initial sizing happens before the scheduler scene is registered. Keep
    // that first paint side-effect free; subsequent calls always have a scene.
    if (destroyed || disabled || !scene) return;
    if (!visible || hidden || reducedMotion || !model.needsFrame) {
      scene.deactivate();
      return;
    }
    // The scheduler is only activated after the model reports runnable work.
    scene.activate();
  }

  function pauseModel(): void {
    if (model.needsFrame) model.pause();
    paint();
    scene?.deactivate();
  }

  function startModel(): void {
    if (destroyed || disabled || hidden || !visible) return;
    if (!started) {
      started = true;
      model.start();
    } else if (model.phase === "paused") {
      model.resume();
    }
    paint();
    activateIfNeeded();
  }

  function resize(): void {
    if (destroyed) return;
    const dimensions = measureCanvas();
    const mobile = dimensions.width <= SKILLS_BREAKPOINT;
    applyCanvasSize(dimensions.width, dimensions.height);
    model.resize(dimensions.width, dimensions.height, mobile);
    paint();
    activateIfNeeded();
  }

  function onIntersection(entries: IntersectionObserverEntry[]): void {
    if (destroyed) return;
    const entry = entries[0];
    visible = Boolean(
      entry?.isIntersecting &&
        (typeof entry.intersectionRatio !== "number" || entry.intersectionRatio > 0),
    );
    if (visible) startModel();
    else if (started) pauseModel();
  }

  function onVisibilityChange(): void {
    hidden = Boolean(ownerDocument?.hidden);
    if (hidden) {
      if (started) pauseModel();
      else scene?.deactivate();
      return;
    }
    if (visible) startModel();
    else activateIfNeeded();
  }

  function onReducedMotionChange(nextReducedMotion: boolean): void {
    if (destroyed || reducedMotion === nextReducedMotion) return;
    reducedMotion = nextReducedMotion;
    if (disabled) return;
    const snapshot = model.setReducedMotion(nextReducedMotion);
    paint(snapshot);
    if (nextReducedMotion) {
      scene?.deactivate();
    } else if (!visible || hidden) {
      // setReducedMotion(false) initializes an entering model. Preserve the
      // offscreen/hidden pause instead of scheduling work that cannot be seen.
      if (model.needsFrame) model.pause();
      scene?.deactivate();
    } else {
      activateIfNeeded();
    }
  }

  function onMouseMove(event: MouseEvent): void {
    const position = pointerPosition(event.clientX, event.clientY);
    if (!position || destroyed || disabled) return;
    model.setPointer(position.x, position.y);
    paint();
    activateIfNeeded();
  }

  function onMouseLeave(): void {
    if (destroyed || disabled) return;
    model.clearPointer();
    paint();
    activateIfNeeded();
  }

  function onTouchMove(event: TouchEvent): void {
    if (destroyed || disabled) return;
    const touch = event.touches[0];
    if (!touch) return;
    const position = pointerPosition(touch.clientX, touch.clientY);
    if (!position) return;
    model.setPointer(position.x, position.y);
    paint();
    activateIfNeeded();
    // Deliberately no preventDefault(): ordinary vertical page scrolling must
    // remain native over the Skills canvas.
  }

  function onTouchEnd(): void {
    onMouseLeave();
  }

  function onSceneFrame(_timestampMs: number, deltaMs: number): boolean {
    if (destroyed || disabled || hidden || !visible || reducedMotion || !model.needsFrame) return false;
    const elapsed = finiteNonNegative(deltaMs) ? deltaMs : 0;
    const result = model.advance(elapsed);
    paint(result.snapshot);
    return result.snapshot.needsFrame;
  }

  function diagnostics(): SkillsSceneDiagnostics {
    const snapshot = model.snapshot();
    const assets = assetRegistry.diagnostics();
    const schedulerDiagnostics = scheduler.diagnostics();
    return {
      started,
      visible,
      active: !disabled && schedulerDiagnostics.activeScenes.includes(sceneName),
      reducedMotion,
      mobileModel: snapshot.mobile,
      seed: snapshot.seed,
      width: snapshot.width,
      height: snapshot.height,
      phase: snapshot.phase,
      simulationMs: snapshot.simulationMs,
      needsFrame: snapshot.needsFrame,
      expectedIcons: manifest.length,
      iconAssetsLoaded: assets.ready,
      iconAssetsPending: assets.pendingKeys.slice(),
      iconAssetsFailed: assets.failedAssets.map((asset) => asset.key),
      assetReadiness: assets,
      assets,
      contextAvailable: context !== null,
      disabled,
      reason: disabled
        ? "disabled-for-scene-isolation"
        : reducedMotion
          ? "reduced-motion"
          : model.needsFrame
            ? "running"
            : "idle",
      chips: snapshot.chips.map((chip) => ({ ...chip })),
    };
  }

  // The initial resize establishes the backing store and paints an empty idle
  // model before intersection starts it. This also makes reduced-motion mount
  // deterministic when the observer fires synchronously in a test.
  resize();
  loadIcons();

  scene = scheduler.register(sceneName, onSceneFrame, { active: false });

  if (options.diagnostics) {
    try {
      options.diagnostics.register(sceneName, diagnostics);
    } catch {
      // Diagnostics are optional and must never prevent the visual scene from
      // mounting (for example, after a hot-reload duplicate registration).
    }
  }

  const canvasTarget = skillCanvas as unknown as ListenerTarget;
  const windowTarget = ownerWindow as unknown as ListenerTarget | undefined;
  const documentTarget = ownerDocument as unknown as ListenerTarget | undefined;

  if (eventListenerTarget(canvasTarget)) {
    canvasTarget.addEventListener("mousemove", onMouseMove as EventListener);
    canvasTarget.addEventListener("mouseleave", onMouseLeave as EventListener);
    // Passive is essential: this listener can observe a touch pointer without
    // taking ownership of native scrolling.
    canvasTarget.addEventListener("touchmove", onTouchMove as EventListener, { passive: true });
    canvasTarget.addEventListener("touchend", onTouchEnd as EventListener, { passive: true });
    canvasTarget.addEventListener("touchcancel", onTouchEnd as EventListener, { passive: true });
  }
  if (eventListenerTarget(windowTarget)) {
    windowTarget.addEventListener("resize", resize as EventListener, { passive: true });
  }
  if (eventListenerTarget(documentTarget)) {
    documentTarget.addEventListener("visibilitychange", onVisibilityChange as EventListener);
  }

  const Observer =
    options.intersectionObserver ??
    (ownerWindow as (Window & { IntersectionObserver?: SkillsIntersectionObserverConstructor }) | undefined)
      ?.IntersectionObserver;
  if (Observer) {
    try {
      const nextObserver = new Observer(onIntersection, { threshold: 0.1 });
      observer = nextObserver;
      nextObserver.observe(skillCanvas);
    } catch {
      observer = null;
      // A missing/failed observer should not make M4 a blank canvas. Treat the
      // scene as visible; the shared scheduler still owns its frames.
      visible = true;
      startModel();
    }
  } else {
    visible = true;
    startModel();
  }

  if (typeof ResizeObserver !== "undefined") {
    try {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(skillCanvas);
    } catch {
      resizeObserver = null;
    }
  }

  const onMediaChange = (event: MediaQueryListEvent): void => {
    onReducedMotionChange(event.matches);
  };
  if (options.onReducedMotionChange) {
    reducedMotionCleanup = options.onReducedMotionChange(onReducedMotionChange);
  } else if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onMediaChange);
      reducedMotionCleanup = () => mediaQuery.removeEventListener("change", onMediaChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onMediaChange);
      reducedMotionCleanup = () => mediaQuery.removeListener(onMediaChange);
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    observer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (eventListenerTarget(canvasTarget)) {
      canvasTarget.removeEventListener("mousemove", onMouseMove as EventListener);
      canvasTarget.removeEventListener("mouseleave", onMouseLeave as EventListener);
      canvasTarget.removeEventListener("touchmove", onTouchMove as EventListener, { passive: true });
      canvasTarget.removeEventListener("touchend", onTouchEnd as EventListener, { passive: true });
      canvasTarget.removeEventListener("touchcancel", onTouchEnd as EventListener, { passive: true });
    }
    if (eventListenerTarget(windowTarget)) windowTarget.removeEventListener("resize", resize as EventListener);
    if (eventListenerTarget(documentTarget)) documentTarget.removeEventListener("visibilitychange", onVisibilityChange as EventListener);
    reducedMotionCleanup?.();
    reducedMotionCleanup = null;
    for (const image of images.values()) {
      image.onload = null;
      image.onerror = null;
    }
    try {
      options.diagnostics?.unregister?.(sceneName);
    } catch {
      // Diagnostics are best-effort and have no bearing on lifecycle cleanup.
    }
    try {
      scene.unregister();
    } catch {
      // The shared scheduler may already have been disposed by its owner.
    }
  }

  return {
    canvas: skillCanvas,
    model,
    simulation: model,
    assetRegistry,
    assets: assetRegistry,
    scene,
    start: () => {
      visible = true;
      startModel();
    },
    pause: pauseModel,
    resume: () => {
      if (destroyed) return;
      visible = true;
      startModel();
    },
    resize,
    snapshot: () => model.snapshot(),
    diagnostics,
    destroy,
  };
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

function isCanvasLike(value: unknown): value is HTMLCanvasElement {
  return Boolean(
    value &&
      typeof (value as HTMLCanvasElement).getContext === "function" &&
      typeof (value as HTMLCanvasElement).addEventListener === "function",
  );
}

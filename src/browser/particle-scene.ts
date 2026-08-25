import {
  PARTICLE_BREAKPOINT,
  ParticleSimulation,
  type ParticleDiagnostics,
  type ParticleSimulationOptions,
  type ParticleSnapshot,
} from "../motion/particle-model";
import {
  MotionScheduler,
  type MotionSchedulerScene,
} from "../motion/scheduler";

/** Narrow optional inspection seam used by the localhost diagnostics page. */
export type ParticleDiagnosticsPort = {
  register(name: string, reader: () => unknown): void;
  unregister?(name: string): void;
};

export type ParticleReducedMotionRegistrar = (
  listener: (reducedMotion: boolean) => void,
) => () => void;

export type ParticleSceneOptions = Readonly<{
  /** The shared lifecycle owner; this adapter never calls requestAnimationFrame. */
  scheduler: MotionScheduler;
  /** Defaults to #pcanvas in the supplied/owner document. */
  canvas?: HTMLCanvasElement | null;
  /** Defaults to the canvas owner document, then the ambient browser document. */
  document?: Document;
  /** Defaults to the canvas owner window, then the ambient browser window. */
  window?: Window;
  /** Stable scene key used by scheduler and diagnostics metrics. */
  sceneName?: string;
  /** Optional localhost-only inspection port. */
  diagnostics?: ParticleDiagnosticsPort;
  /** Explicit policy override; otherwise matchMedia/scheduler is consulted. */
  reducedMotion?: boolean;
  /** Lifecycle-owned reduced motion listener, when available. */
  onReducedMotionChange?: ParticleReducedMotionRegistrar;
  /** Disable this scene while retaining a named, inspectable registration. */
  disabled?: boolean;
  /** Fixed dimensions are useful for embedded canvases and deterministic tests. */
  width?: number;
  height?: number;
  /** Optional model seam for deterministic browser tests. */
  model?: ParticleSimulation;
  /** Overrides passed to a model created by this adapter. */
  modelOptions?: Omit<ParticleSimulationOptions, "width" | "height" | "mobile" | "reducedMotion">;
}>;

export type ParticleSceneActivityReason =
  | ParticleDiagnostics["reason"]
  | "disabled-for-scene-isolation";

export type ParticleSceneDiagnostics = Omit<ParticleDiagnostics, "reason"> & {
  sceneName: string;
  active: boolean;
  settled: boolean;
  mobileReason: string | null;
  contextAvailable: boolean;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  backingWidth: number;
  backingHeight: number;
  reason: ParticleSceneActivityReason;
};

export type ParticleSceneHandle = {
  readonly canvas: HTMLCanvasElement;
  readonly model: ParticleSimulation;
  readonly simulation: ParticleSimulation;
  readonly scene: MotionSchedulerScene;
  start(): void;
  pause(): void;
  resume(): void;
  resize(): void;
  snapshot(): ParticleSnapshot;
  diagnostics(): ParticleSceneDiagnostics;
  destroy(): void;
  dispose(): void;
};

type ListenerTarget = {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void;
};

type CanvasContext = CanvasRenderingContext2D & {
  setTransform?: (...args: number[]) => void;
};

const DEFAULT_DPR_CAP = 2;
const DEFAULT_WIDTH = 1;
const DEFAULT_HEIGHT = 1;

function ambientDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function ambientWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCanvasLike(value: unknown): value is HTMLCanvasElement {
  return Boolean(value && typeof (value as HTMLCanvasElement).getContext === "function");
}

function eventTarget(value: unknown): value is ListenerTarget {
  return Boolean(
    value &&
      typeof (value as ListenerTarget).addEventListener === "function" &&
      typeof (value as ListenerTarget).removeEventListener === "function",
  );
}

function getContext(canvas: HTMLCanvasElement): CanvasContext | null {
  try {
    return canvas.getContext("2d") as CanvasContext | null;
  } catch {
    return null;
  }
}

function readDimension(
  explicit: number | undefined,
  canvas: HTMLCanvasElement,
  property: "width" | "height",
  windowValue: number | undefined,
  fallback: number,
): number {
  if (positiveFinite(explicit)) return explicit;
  // This adapter owns a fixed full-viewport background. Its previous inline
  // canvas size is stale after a viewport resize, so the live window dimension
  // must win over the element's current rectangle/client size.
  if (positiveFinite(windowValue)) return windowValue;
  let measured: number | undefined;
  try {
    const rect = canvas.getBoundingClientRect();
    measured = property === "width" ? rect.width : rect.height;
  } catch {
    measured = undefined;
  }
  if (!positiveFinite(measured)) {
    const candidate = property === "width" ? canvas.clientWidth : canvas.clientHeight;
    measured = positiveFinite(candidate) ? candidate : undefined;
  }
  if (!positiveFinite(measured)) {
    const backing = property === "width" ? canvas.width : canvas.height;
    measured = positiveFinite(backing) ? backing : undefined;
  }
  return measured ?? fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Mounts the decorative particle field as a shallow canvas adapter.
 *
 * Policy and time stay in MotionScheduler/ParticleSimulation. This function
 * only wires browser dimensions, pointer input, painting, and cleanup.
 */
export function mountParticleScene(options: ParticleSceneOptions): ParticleSceneHandle | null {
  if (!options.scheduler) throw new TypeError("mountParticleScene requires a MotionScheduler");

  const ownerDocument = options.document ?? options.canvas?.ownerDocument ?? ambientDocument();
  const suppliedCanvas = options.canvas;
  const foundCanvas = suppliedCanvas ?? ownerDocument?.getElementById("pcanvas");
  if (!isCanvasLike(foundCanvas)) return null;
  const canvas = foundCanvas as HTMLCanvasElement;
  const ownerWindow = options.window ?? ownerDocument?.defaultView ?? ambientWindow();
  const scheduler = options.scheduler;
  const sceneName = options.sceneName ?? "particles";
  const diagnosticsPort = options.diagnostics;
  const context = getContext(canvas);
  const disabled = options.disabled === true;
  // A lifecycle registrar is the authority in the production composition. Do
  // not also sample matchMedia here: doing so creates a race where an adapter
  // starts under one preference and the shared lifecycle immediately reports
  // another. The local query remains available for direct consumers that do
  // not provide the shared registrar.
  const mediaQuery =
    options.reducedMotion === undefined && !options.onReducedMotionChange
      ? ownerWindow?.matchMedia?.("(prefers-reduced-motion: reduce)")
      : undefined;
  let reducedMotion =
    options.reducedMotion ??
    (options.onReducedMotionChange ? scheduler.reducedMotion : mediaQuery?.matches ?? scheduler.reducedMotion);
  let destroyed = false;
  let cssWidth = DEFAULT_WIDTH;
  let cssHeight = DEFAULT_HEIGHT;
  let dpr = 1;
  let mobile = false;
  let sceneActive = false;

  function measure(): { width: number; height: number; mobile: boolean } {
    const width = readDimension(
      options.width,
      canvas,
      "width",
      ownerDocument?.documentElement.clientWidth || ownerWindow?.innerWidth,
      DEFAULT_WIDTH,
    );
    const height = readDimension(
      options.height,
      canvas,
      "height",
      ownerDocument?.documentElement.clientHeight || ownerWindow?.innerHeight,
      DEFAULT_HEIGHT,
    );
    return { width, height, mobile: width <= PARTICLE_BREAKPOINT };
  }

  const measured = measure();
  cssWidth = measured.width;
  cssHeight = measured.height;
  mobile = measured.mobile;
  const model =
    options.model ??
    new ParticleSimulation({
      ...(options.modelOptions ?? {}),
      width: cssWidth,
      height: cssHeight,
      mobile,
      reducedMotion: reducedMotion || disabled,
      autoStart: false,
    });
  const simulation = model;

  function applyCanvasSize(): void {
    const devicePixelRatio = ownerWindow?.devicePixelRatio;
    dpr = Math.min(Math.max(positiveFinite(devicePixelRatio) ? devicePixelRatio : 1, 1), DEFAULT_DPR_CAP);
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    if (canvas.style) {
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    if (context?.setTransform) context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear(): void {
    if (!context) return;
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.globalAlpha = 1;
  }

  function setHidden(hidden: boolean): void {
    try {
      scheduler.setHidden(hidden);
    } catch {
      // A disposed parent scheduler is terminal; destroy() remains safe.
    }
  }

  function activate(): void {
    if (destroyed || disabled || mobile || reducedMotion) return;
    try {
      sceneActive = model.needsFrame;
      if (sceneActive) scene.activate();
    } catch {
      sceneActive = false;
    }
  }

  function deactivate(): void {
    sceneActive = false;
    if (destroyed) return;
    try {
      scene.deactivate();
    } catch {
      // Parent scheduler disposal is intentionally idempotent for this adapter.
    }
  }

  function applyPolicy(nextReducedMotion: boolean): void {
    if (destroyed || reducedMotion === nextReducedMotion) return;
    reducedMotion = nextReducedMotion;
    try {
      model.setReducedMotion(reducedMotion || disabled);
    } catch {
      return;
    }
    if (reducedMotion || mobile || disabled) {
      deactivate();
      clear();
    } else {
      model.start();
      paint(model.snapshot());
      activate();
    }
  }

  function resize(): void {
    if (destroyed) return;
    const next = measure();
    const changed = next.width !== cssWidth || next.height !== cssHeight || next.mobile !== mobile;
    cssWidth = next.width;
    cssHeight = next.height;
    mobile = next.mobile;
    applyCanvasSize();
    if (!changed) return;

    try {
      model.resize(cssWidth, cssHeight, mobile);
    } catch {
      return;
    }
    if (mobile || reducedMotion || disabled) {
      deactivate();
      clear();
      return;
    }
    model.start();
    paint(model.snapshot());
    activate();
  }

  function pointerPosition(event: MouseEvent): { x: number; y: number } | null {
    const x = finiteOr(event.clientX, Number.NaN);
    const y = finiteOr(event.clientY, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let rect: DOMRect | undefined;
    try {
      rect = canvas.getBoundingClientRect();
    } catch {
      rect = undefined;
    }
    return {
      x: x - (rect?.left ?? 0),
      y: y - (rect?.top ?? 0),
    };
  }

  function onMouseMove(event: Event): void {
    if (mobile || reducedMotion || disabled || destroyed) return;
    const position = pointerPosition(event as MouseEvent);
    if (!position) return;
    try {
      model.setPointer(position.x, position.y);
      paint(model.snapshot());
    } catch {
      // Invalid injected event doubles cannot affect the scheduler lifecycle.
    }
  }

  function onMouseLeave(): void {
    if (destroyed) return;
    model.clearPointer();
    paint(model.snapshot());
  }

  function drawPointerGlow(snapshot: ParticleSnapshot): void {
    if (!context || !snapshot.pointer) return;
    const pointer = snapshot.pointer;
    const gradient = context.createRadialGradient(
      pointer.x,
      pointer.y,
      0,
      pointer.x,
      pointer.y,
      140,
    );
    gradient.addColorStop(0, "rgba(235,0,101,0.12)");
    gradient.addColorStop(0.5, "rgba(236,72,153,0.05)");
    gradient.addColorStop(1, "transparent");
    context.globalAlpha = 1;
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(pointer.x, pointer.y, 140, 0, Math.PI * 2);
    context.fill();
  }

  function drawLinks(snapshot: ParticleSnapshot): void {
    if (!context) return;
    for (const link of snapshot.links) {
      const first = snapshot.particles[link.a];
      const second = snapshot.particles[link.b];
      if (!first || !second) continue;
      context.globalAlpha = Math.max(0, Math.min(0.28, (1 - link.distance / 90) * 0.28));
      context.strokeStyle = link.color;
      context.lineWidth = 0.5;
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(second.x, second.y);
      context.stroke();
    }
  }

  function drawParticles(snapshot: ParticleSnapshot): void {
    if (!context) return;
    for (const particle of snapshot.particles) {
      const fadeIn = Math.min(1, particle.ageMs / 1_000);
      const fadeOut = Math.min(1, Math.max(0, (particle.maxAgeMs - particle.ageMs) / 1_000));
      const alpha = particle.alpha * Math.min(fadeIn, fadeOut);
      if (particle.glow) {
        const radius = particle.r * 4.5;
        const gradient = context.createRadialGradient(
          particle.x,
          particle.y,
          0,
          particle.x,
          particle.y,
          radius,
        );
        gradient.addColorStop(0, `${particle.color}cc`);
        gradient.addColorStop(0.4, `${particle.color}55`);
        gradient.addColorStop(1, `${particle.color}00`);
        context.globalAlpha = alpha * 0.9;
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = alpha;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
      context.fill();
    }
  }

  function paint(snapshot: ParticleSnapshot): void {
    if (!context || destroyed) return;
    clear();
    if (snapshot.mobile || snapshot.reducedMotion || disabled) return;
    drawPointerGlow(snapshot);
    drawLinks(snapshot);
    drawParticles(snapshot);
    context.globalAlpha = 1;
  }

  function onFrame(_timestampMs: number, deltaMs: number): boolean {
    if (destroyed || disabled || mobile || reducedMotion || scheduler.hidden) return false;
    const result = model.advance(deltaMs);
    paint(result.snapshot);
    sceneActive = model.needsFrame;
    return model.needsFrame;
  }

  let scene: MotionSchedulerScene;
  // A supplied model can be reused by a host, but policy/dimensions still
  // belong to this adapter's current viewport contract.
  if (model.width !== cssWidth || model.height !== cssHeight || model.mobile !== mobile) {
    model.resize(cssWidth, cssHeight, mobile);
  }
  if (model.reducedMotion !== (reducedMotion || disabled)) {
    model.setReducedMotion(reducedMotion || disabled);
  }
  applyCanvasSize();
  scene = scheduler.register(sceneName, onFrame, {
    active: !disabled && !mobile && !reducedMotion && model.needsFrame,
  });

  const listeners: Array<() => void> = [];
  const addListener = (
    target: unknown,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    if (!eventTarget(target)) return;
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  };

  addListener(ownerWindow, "resize", resize as EventListener);
  addListener(ownerDocument, "visibilitychange", () => {
    setHidden(Boolean(ownerDocument?.hidden));
  });
  addListener(ownerDocument, "mousemove", onMouseMove);
  addListener(ownerDocument, "mouseleave", onMouseLeave);

  if (mediaQuery) {
    const onMediaChange = (event: MediaQueryListEvent): void => applyPolicy(event.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onMediaChange);
      listeners.push(() => mediaQuery.removeEventListener("change", onMediaChange));
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onMediaChange);
      listeners.push(() => mediaQuery.removeListener(onMediaChange));
    }
  }
  if (options.onReducedMotionChange) {
    listeners.push(options.onReducedMotionChange(applyPolicy));
  }

  function diagnostics(): ParticleSceneDiagnostics {
    const modelDiagnostics = model.diagnostics();
    const active =
      !destroyed &&
      sceneActive &&
      !disabled &&
      !mobile &&
      !reducedMotion &&
      !scheduler.hidden &&
      !scheduler.reducedMotion;
    const reason: ParticleSceneActivityReason = disabled
      ? "disabled-for-scene-isolation"
      : modelDiagnostics.reason;
    return {
      ...modelDiagnostics,
      sceneName,
      active,
      settled: modelDiagnostics.settled,
      mobileReason: mobile ? `viewport-width<=${PARTICLE_BREAKPOINT}` : null,
      contextAvailable: context !== null,
      cssWidth,
      cssHeight,
      dpr,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      reason,
    };
  }

  if (diagnosticsPort) diagnosticsPort.register(sceneName, diagnostics);
  if (ownerDocument?.hidden) setHidden(true);

  function start(): void {
    if (destroyed || disabled || mobile || reducedMotion) return;
    model.start();
    paint(model.snapshot());
    activate();
  }

  function pause(): void {
    if (destroyed) return;
    model.pause();
    deactivate();
    paint(model.snapshot());
  }

  function resume(): void {
    if (destroyed || disabled || mobile || reducedMotion) return;
    model.resume();
    model.start();
    paint(model.snapshot());
    activate();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    deactivate();
    listeners.splice(0).forEach((remove) => remove());
    try {
      scene.unregister();
    } catch {
      // A parent scheduler may already have been disposed.
    }
    diagnosticsPort?.unregister?.(sceneName);
    clear();
  }

  // Paint the initial state (desktop) even before the scheduler's first tick.
  if (!disabled && !mobile && !reducedMotion) {
    model.start();
    paint(model.snapshot());
    sceneActive = model.needsFrame;
    activate();
  } else {
    clear();
  }

  return {
    canvas,
    model,
    simulation,
    scene,
    start,
    pause,
    resume,
    resize,
    snapshot: () => model.snapshot(),
    diagnostics,
    destroy,
    dispose: destroy,
  };
}

export const mountParticleField = mountParticleScene;

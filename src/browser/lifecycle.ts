import {
  MotionScheduler,
  type MotionSceneCallback,
  type MotionSceneOptions,
  type MotionSchedulerDiagnostics,
  type MotionSchedulerScene,
} from "../motion/scheduler";

type MotionDiagnosticsApi = {
  register(name: string, reader: () => unknown): void;
  unregister?(name: string): void;
  isDisabled(name: string): boolean;
};

type ReducedMotionListener = (reducedMotion: boolean) => void;

const scheduler = new MotionScheduler();
const reducedMotionListeners = new Set<ReducedMotionListener>();
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const lifecycleCleanups: Array<() => void> = [];
let lifecycleDisposed = false;

function setReducedMotion(reducedMotion: boolean): void {
  if (lifecycleDisposed) return;
  scheduler.setReducedMotion(reducedMotion);
  [...reducedMotionListeners].forEach((listener) => listener(reducedMotion));
}

function onReducedMotionChange(listener: ReducedMotionListener): () => void {
  if (lifecycleDisposed) return () => undefined;
  reducedMotionListeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    reducedMotionListeners.delete(listener);
  };
}

function isMotionDisabled(name: string): boolean {
  return Boolean(diagnosticsApi()?.isDisabled(name));
}

function registerMotionScene(
  name: string,
  callback: MotionSceneCallback,
  options: MotionSceneOptions = {},
): MotionSchedulerScene {
  return scheduler.register(name, callback, options);
}

function schedulerSnapshot(): MotionSchedulerDiagnostics {
  return scheduler.diagnostics();
}

/** Tear down browser-owned lifecycle listeners and the shared scheduler. */
function disposeMotionLifecycle(): void {
  if (lifecycleDisposed) return;
  lifecycleDisposed = true;
  lifecycleCleanups.splice(0).forEach((remove) => remove());
  reducedMotionListeners.clear();
  scheduler.dispose();
}

/**
 * Connect the shared scheduler to the optional browser diagnostics port.
 *
 * Diagnostics are installed by the browser entry point before scenes mount.
 * Keeping this registration explicit avoids the import-order race where the
 * lifecycle module would otherwise be evaluated before setupMotionDiagnostics.
 */
function registerSchedulerDiagnostics(diagnostics?: MotionDiagnosticsApi): () => void {
  if (!diagnostics) return () => undefined;
  diagnostics.register("scheduler", schedulerSnapshot);
  return () => diagnostics.unregister?.("scheduler");
}

function diagnosticsApi(): MotionDiagnosticsApi | undefined {
  return (window as Window & { __portfolioMotion?: MotionDiagnosticsApi }).__portfolioMotion;
}

// The scheduler is intentionally created in production too. Diagnostics remain
// query-gated, but all decorative scenes use this same frame owner regardless
// of whether the inspection API is exposed. It is kept private to this module
// so normal URLs do not leak a second inspection surface.
scheduler.setHidden(document.hidden);
scheduler.setReducedMotion(reducedMotionQuery.matches);

const onVisibilityChange = (): void => {
  scheduler.setHidden(document.hidden);
};
document.addEventListener("visibilitychange", onVisibilityChange);
lifecycleCleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

const onMediaChange = (event: MediaQueryListEvent) => {
  setReducedMotion(event.matches);
};
if (typeof reducedMotionQuery.addEventListener === "function") {
  reducedMotionQuery.addEventListener("change", onMediaChange);
  lifecycleCleanups.push(() => reducedMotionQuery.removeEventListener("change", onMediaChange));
} else {
  reducedMotionQuery.addListener(onMediaChange);
  lifecycleCleanups.push(() => reducedMotionQuery.removeListener(onMediaChange));
}

// A persisted pagehide freezes the document without destroying its JS graph.
// Pause explicitly, then restore scheduler eligibility on pageshow in case a
// browser does not emit a matching visibilitychange around BFCache restore.
const onPageHide = (): void => {
  if (lifecycleDisposed) return;
  scheduler.setHidden(true);
};
const onPageShow = (): void => {
  if (lifecycleDisposed) return;
  scheduler.setHidden(document.hidden);
  setReducedMotion(reducedMotionQuery.matches);
};
window.addEventListener("pagehide", onPageHide);
window.addEventListener("pageshow", onPageShow);
lifecycleCleanups.push(() => window.removeEventListener("pagehide", onPageHide));
lifecycleCleanups.push(() => window.removeEventListener("pageshow", onPageShow));

export {
  isMotionDisabled,
  onReducedMotionChange,
  disposeMotionLifecycle,
  registerSchedulerDiagnostics,
  registerMotionScene,
  scheduler as motionScheduler,
};

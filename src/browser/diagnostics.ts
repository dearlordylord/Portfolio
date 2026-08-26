/**
 * The optional, read-only inspection surface used by local motion tests.
 *
 * Keeping this adapter at the browser boundary is intentional: motion scenes
 * only depend on the tiny registration port, while the page does not expose
 * any inspection state on a normal (non-loopback) URL.
 */

export type MotionDiagnosticsReader = () => unknown;

export type MotionDiagnosticsElementSnapshot = {
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
  style: {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    position: string;
    transform: string;
    overflow: string;
  };
};

export type MotionDiagnosticsAnimationSnapshot = {
  id: string | null;
  target: string | null;
  playState: AnimationPlayState;
  currentTime: number | null;
  timing: {
    delay: number;
    duration: number;
    iterations: number;
    progress: number | null;
    currentIteration: number | null;
  } | null;
};

export type MotionDiagnosticsVisualViewportSnapshot = {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
};

export type MotionDiagnosticsSnapshot = {
  version: 1;
  capturedAt: number;
  viewport: {
    innerWidth: number;
    innerHeight: number;
    dpr: number;
    visual: MotionDiagnosticsVisualViewportSnapshot | null;
  };
  scroll: {
    x: number;
    y: number;
  };
  elements: Record<string, MotionDiagnosticsElementSnapshot | null>;
  animations: MotionDiagnosticsAnimationSnapshot[];
  scenes: Record<string, unknown>;
};

/**
 * The narrow dependency accepted by browser scene adapters.  This type is
 * deliberately serializable at the `snapshot()` boundary, but scene readers
 * themselves may return their domain-specific diagnostic objects.
 */
export type MotionDiagnosticsPort = {
  readonly version: 1;
  register(name: string, reader: MotionDiagnosticsReader): void;
  unregister(name: string): void;
  isDisabled(name: string): boolean;
  snapshot(): MotionDiagnosticsSnapshot;
};

export type MotionDiagnosticsOptions = Readonly<{
  /** Dependency seams keep the URL/DOM gate straightforward to test. */
  window?: Window;
  document?: Document;
  /** Defaults to `motionDiagnostics`. Presence, rather than value, is the gate. */
  queryParameter?: string;
  /** Defaults to `motionDisable`. Values are comma-separated scene names. */
  disabledQueryParameter?: string;
  /** Dev-only composition may explicitly permit a phone/LAN hostname. */
  allowNonLoopback?: boolean;
  /** IDs captured in every snapshot. */
  trackedElementIds?: readonly string[];
}>;

const DEFAULT_QUERY_PARAMETER = "motionDiagnostics";
const DEFAULT_DISABLED_QUERY_PARAMETER = "motionDisable";

/**
 * These are the stable DOM anchors used by the browser motion contract.  Keep
 * this list small and semantic: snapshots are consumed by tests and humans,
 * not as a dump of every element on the page.
 */
export const DEFAULT_TRACKED_MOTION_ELEMENT_IDS = [
  "scrolly",
  "scrolly-canvas",
  "st1",
  "st2",
  "st-reduced",
  "explore-cta",
  "scroll-hint",
  "about",
  "skills",
  "skillcanvas",
  "contact",
] as const;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function readDisabledScenes(search: string, queryParameter: string): Set<string> {
  const params = new URLSearchParams(search);
  return new Set(
    (params.get(queryParameter) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function snapshotElement(
  ownerWindow: Window,
  ownerDocument: Document,
  id: string,
): MotionDiagnosticsElementSnapshot | null {
  const element = ownerDocument.getElementById(id);
  if (!element) return null;

  const box = element.getBoundingClientRect();
  const style = ownerWindow.getComputedStyle(element);
  return {
    rect: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      left: box.left,
    },
    style: {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      position: style.position,
      transform: style.transform,
      overflow: style.overflow,
    },
  };
}

function animationTargetName(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const element = target as Element;
  if (typeof element.getAttribute !== "function") return null;
  return element.id || element.getAttribute("class") || element.tagName || null;
}

function snapshotAnimation(animation: Animation): MotionDiagnosticsAnimationSnapshot {
  const effect = animation.effect;
  const target = effect && "target" in effect ? effect.target : null;
  const timing = effect && typeof effect.getComputedTiming === "function" ? effect.getComputedTiming() : null;

  return {
    id: animation.id || null,
    target: animationTargetName(target),
    playState: animation.playState,
    currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
    timing: timing
      ? {
          delay: typeof timing.delay === "number" ? timing.delay : 0,
          duration: typeof timing.duration === "number" ? timing.duration : 0,
          iterations: typeof timing.iterations === "number" ? timing.iterations : 0,
          progress: typeof timing.progress === "number" ? timing.progress : null,
          currentIteration: typeof timing.currentIteration === "number" ? timing.currentIteration : null,
        }
      : null,
  };
}

function snapshotAnimations(ownerDocument: Document): MotionDiagnosticsAnimationSnapshot[] {
  // `getAnimations` is not present in a few test DOM implementations.  The
  // absence of native animations should be represented as an empty list.
  if (typeof ownerDocument.getAnimations !== "function") return [];

  return ownerDocument.getAnimations().map((animation) => {
    try {
      return snapshotAnimation(animation);
    } catch {
      return {
        id: animation.id || null,
        target: null,
        playState: animation.playState,
        currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
        timing: null,
      };
    }
  });
}

function readCapturedTime(ownerWindow: Window): number {
  return typeof ownerWindow.performance?.now === "function" ? ownerWindow.performance.now() : Date.now();
}

/**
 * Install the local diagnostics port when—and only when—the page is on a
 * loopback host and the opt-in query flag is present.
 *
 * The returned port is also assigned to `window.__portfolioMotion` so browser
 * automation can inspect the same object the scenes use.  Callers should pass
 * the return value to scene mount functions rather than reaching into globals.
 */
export function setupMotionDiagnostics(options: MotionDiagnosticsOptions = {}): MotionDiagnosticsPort | undefined {
  const ownerWindow = options.window ?? window;
  const ownerDocument = options.document ?? ownerWindow.document;
  const globalWindow = ownerWindow as Window & { __portfolioMotion?: MotionDiagnosticsPort };
  const queryParameter = options.queryParameter ?? DEFAULT_QUERY_PARAMETER;
  const disabledQueryParameter = options.disabledQueryParameter ?? DEFAULT_DISABLED_QUERY_PARAMETER;

  // Clear a stale hot-reload surface before returning.  The page must never
  // leave diagnostics exposed after either side of the gate is removed.
  if (!isLoopbackHostname(ownerWindow.location.hostname) && options.allowNonLoopback !== true) {
    delete globalWindow.__portfolioMotion;
    return undefined;
  }

  const params = new URLSearchParams(ownerWindow.location.search);
  if (!params.has(queryParameter)) {
    delete globalWindow.__portfolioMotion;
    return undefined;
  }

  const disabledScenes = readDisabledScenes(ownerWindow.location.search, disabledQueryParameter);
  const trackedIds = options.trackedElementIds ?? DEFAULT_TRACKED_MOTION_ELEMENT_IDS;
  const readers = new Map<string, MotionDiagnosticsReader>();

  const port: MotionDiagnosticsPort = {
    version: 1,
    register(name, reader) {
      if (typeof name !== "string" || typeof reader !== "function") return;
      readers.set(name, reader);
    },
    unregister(name) {
      readers.delete(name);
    },
    isDisabled(name) {
      return disabledScenes.has(name);
    },
    snapshot() {
      const scenes: Record<string, unknown> = {};
      readers.forEach((reader, name) => {
        try {
          scenes[name] = reader();
        } catch (error) {
          scenes[name] = { error: String(error) };
        }
      });

      const elements: Record<string, MotionDiagnosticsElementSnapshot | null> = {};
      trackedIds.forEach((id) => {
        try {
          elements[id] = snapshotElement(ownerWindow, ownerDocument, id);
        } catch {
          elements[id] = null;
        }
      });

      return {
        version: 1,
        capturedAt: readCapturedTime(ownerWindow),
        viewport: {
          innerWidth: ownerWindow.innerWidth,
          innerHeight: ownerWindow.innerHeight,
          dpr: ownerWindow.devicePixelRatio || 1,
          visual: ownerWindow.visualViewport
            ? {
                width: ownerWindow.visualViewport.width,
                height: ownerWindow.visualViewport.height,
                offsetTop: ownerWindow.visualViewport.offsetTop,
                offsetLeft: ownerWindow.visualViewport.offsetLeft,
                scale: ownerWindow.visualViewport.scale,
              }
            : null,
        },
        scroll: {
          x: ownerWindow.scrollX,
          y: ownerWindow.scrollY,
        },
        elements,
        animations: snapshotAnimations(ownerDocument),
        scenes,
      };
    },
  };

  globalWindow.__portfolioMotion = port;
  return port;
}

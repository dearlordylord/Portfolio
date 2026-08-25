/** A browser frame handle returned by requestAnimationFrame. */
export type MotionFrameHandle = number;

/** The callback shape accepted by an injected frame driver. */
export type MotionFrameCallback = (timestampMs: number) => void;

export type RequestMotionFrame = (callback: MotionFrameCallback) => MotionFrameHandle;
export type CancelMotionFrame = (handle: MotionFrameHandle) => void;
export type MotionNow = () => number;

/**
 * A scene owns its state and tells the scheduler whether it still needs a frame.
 * The scheduler supplies one timestamp and one elapsed interval to every scene
 * invoked by the same underlying animation frame.
 */
export type MotionSceneCallback = (timestampMs: number, deltaMs: number) => boolean;

export type MotionSceneOptions = {
  /** Registered scenes are active by default. */
  active?: boolean;
};

export type MotionSchedulerOptions = {
  requestFrame?: RequestMotionFrame;
  cancelFrame?: CancelMotionFrame;
  now?: MotionNow;
};

/** A small lifecycle handle returned from {@link MotionScheduler.register}. */
export type MotionSchedulerScene = {
  readonly name: string;
  activate(): boolean;
  deactivate(): boolean;
  unregister(): boolean;
};

/**
 * JSON-safe scheduler state. `activeSceneNames` describes caller-requested
 * active scenes; `activeScenes` describes scenes that currently have runnable
 * work and therefore count as active animation systems.
 */
export type MotionSchedulerDiagnostics = {
  activeScenes: string[];
  activeSceneNames: string[];
  registeredActiveScenes: string[];
  pendingFrame: boolean;
  pendingFrameId: MotionFrameHandle | null;
  totalTicks: number;
  sceneTicks: Record<string, number>;
  hidden: boolean;
  reducedMotion: boolean;
  lastTimestampMs: number | null;
  lastDeltaMs: number;
  lastFrameDeltaMs: number;
  disposed: boolean;
};

type SceneRecord = {
  readonly name: string;
  readonly callback: MotionSceneCallback;
  active: boolean;
  needsFrame: boolean;
  ticks: number;
  /** Changes whenever lifecycle methods mutate this scene during a tick. */
  version: number;
};

type PendingFrame = {
  readonly token: number;
  handle: MotionFrameHandle | null;
};

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function defaultRequestFrame(callback: MotionFrameCallback): MotionFrameHandle {
  if (typeof requestAnimationFrame !== "function") {
    throw new Error("MotionScheduler requires an injected requestFrame outside a browser");
  }
  return requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: MotionFrameHandle): void {
  if (typeof cancelAnimationFrame !== "function") {
    throw new Error("MotionScheduler requires an injected cancelFrame outside a browser");
  }
  cancelAnimationFrame(handle);
}

function assertSceneName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("Motion scene name must be a non-empty string");
  }
}

function assertSceneCallback(callback: MotionSceneCallback): void {
  if (typeof callback !== "function") {
    throw new TypeError("Motion scene callback must be a function");
  }
}

/**
 * Coordinates all registered animation scenes through one requestAnimationFrame.
 *
 * Scene callbacks are deliberately policy-free: they only receive time and
 * return whether another frame is needed. Visibility, reduced motion, frame
 * ownership, cancellation, and lifecycle changes stay inside this module.
 */
export class MotionScheduler {
  readonly #requestFrame: RequestMotionFrame;
  readonly #cancelFrame: CancelMotionFrame;
  readonly #now: MotionNow;
  readonly #scenes = new Map<string, SceneRecord>();

  #pendingFrame: PendingFrame | null = null;
  #nextFrameToken = 0;
  #isTicking = false;
  #hidden = false;
  #reducedMotion = false;
  #disposed = false;
  #totalTicks = 0;
  #lastTimestampMs: number | null = null;
  #lastDeltaMs = 0;

  constructor(options: MotionSchedulerOptions = {}) {
    this.#requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.#cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.#now = options.now ?? defaultNow;
  }

  /**
   * Registers a named scene and returns a lifecycle handle. A scene starts
   * active unless `{ active: false }` is supplied.
   */
  register(
    name: string,
    callback: MotionSceneCallback,
    options: MotionSceneOptions = {},
  ): MotionSchedulerScene {
    this.#assertUsable();
    assertSceneName(name);
    assertSceneCallback(callback);
    if (this.#scenes.has(name)) throw new Error(`Motion scene already registered: ${name}`);

    const active = options.active ?? true;
    const record: SceneRecord = {
      name,
      callback,
      active,
      needsFrame: active,
      ticks: 0,
      version: 0,
    };
    this.#scenes.set(name, record);

    try {
      this.#scheduleIfNeeded();
    } catch (error) {
      this.#scenes.delete(name);
      throw error;
    }

    return {
      name,
      activate: () => this.activate(name),
      deactivate: () => this.deactivate(name),
      unregister: () => this.unregister(name),
    };
  }

  /** Alias useful to callers that prefer an explicit verb. */
  registerScene(
    name: string,
    callback: MotionSceneCallback,
    options: MotionSceneOptions = {},
  ): MotionSchedulerScene {
    return this.register(name, callback, options);
  }

  /** Marks a registered scene as needing a frame. */
  activate(name: string): boolean {
    this.#assertUsable();
    const scene = this.#scenes.get(name);
    if (!scene) return false;
    scene.active = true;
    scene.needsFrame = true;
    scene.version += 1;
    this.#scheduleIfNeeded();
    return true;
  }

  activateScene(name: string): boolean {
    return this.activate(name);
  }

  /** Stops a scene and cancels the shared frame if it was the last work item. */
  deactivate(name: string): boolean {
    this.#assertUsable();
    const scene = this.#scenes.get(name);
    if (!scene) return false;
    scene.active = false;
    scene.needsFrame = false;
    scene.version += 1;
    this.#scheduleIfNeeded();
    return true;
  }

  deactivateScene(name: string): boolean {
    return this.deactivate(name);
  }

  /** Removes a scene and its per-scene diagnostic counters. */
  unregister(name: string): boolean {
    this.#assertUsable();
    const removed = this.#scenes.delete(name);
    if (removed) this.#scheduleIfNeeded();
    return removed;
  }

  unregisterScene(name: string): boolean {
    return this.unregister(name);
  }

  /** Pauses all callbacks while the document is hidden. */
  setHidden(hidden: boolean): void {
    this.#assertUsable();
    if (this.#hidden === hidden) return;
    this.#hidden = hidden;
    this.#resetElapsedTime();
    if (hidden) this.#cancelPendingFrame();
    else this.#scheduleIfNeeded();
  }

  setDocumentHidden(hidden: boolean): void {
    this.setHidden(hidden);
  }

  /** Pauses all callbacks while reduced-motion policy is enabled. */
  setReducedMotion(reducedMotion: boolean): void {
    this.#assertUsable();
    if (this.#reducedMotion === reducedMotion) return;
    this.#reducedMotion = reducedMotion;
    this.#resetElapsedTime();
    if (reducedMotion) this.#cancelPendingFrame();
    else this.#scheduleIfNeeded();
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  /** Returns a fresh, serializable diagnostics object. */
  diagnostics(): MotionSchedulerDiagnostics {
    const activeSceneNames: string[] = [];
    const activeScenes: string[] = [];
    const sceneTicksEntries: Array<[string, number]> = [];

    for (const scene of this.#scenes.values()) {
      sceneTicksEntries.push([scene.name, scene.ticks]);
      if (scene.active) activeSceneNames.push(scene.name);
      if (this.#canRun(scene)) activeScenes.push(scene.name);
    }

    const sceneTicks = Object.fromEntries(sceneTicksEntries);

    return {
      activeScenes,
      activeSceneNames,
      registeredActiveScenes: [...activeSceneNames],
      pendingFrame: this.#pendingFrame !== null,
      pendingFrameId: this.#pendingFrame?.handle ?? null,
      totalTicks: this.#totalTicks,
      sceneTicks,
      hidden: this.#hidden,
      reducedMotion: this.#reducedMotion,
      lastTimestampMs: this.#lastTimestampMs,
      lastDeltaMs: this.#lastDeltaMs,
      lastFrameDeltaMs: this.#lastDeltaMs,
      disposed: this.#disposed,
    };
  }

  metrics(): MotionSchedulerDiagnostics {
    return this.diagnostics();
  }

  snapshot(): MotionSchedulerDiagnostics {
    return this.diagnostics();
  }

  /** Stops pending work and makes this scheduler unusable for new scenes. */
  dispose(): void {
    if (this.#disposed) return;
    this.#cancelPendingFrame();
    this.#disposed = true;
    this.#scenes.clear();
    this.#resetElapsedTime();
  }

  destroy(): void {
    this.dispose();
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("MotionScheduler has been disposed");
  }

  #resetElapsedTime(): void {
    this.#lastTimestampMs = null;
    this.#lastDeltaMs = 0;
  }

  #canRun(scene: SceneRecord): boolean {
    return (
      !this.#disposed &&
      !this.#hidden &&
      !this.#reducedMotion &&
      scene.active &&
      scene.needsFrame
    );
  }

  #hasRunnableWork(): boolean {
    for (const scene of this.#scenes.values()) {
      if (this.#canRun(scene)) return true;
    }
    return false;
  }

  #scheduleIfNeeded(): void {
    if (this.#disposed || this.#isTicking || this.#pendingFrame || !this.#hasRunnableWork()) {
      if (!this.#isTicking && !this.#hasRunnableWork()) this.#cancelPendingFrame();
      return;
    }

    const pending: PendingFrame = { token: ++this.#nextFrameToken, handle: null };
    this.#pendingFrame = pending;
    try {
      const handle = this.#requestFrame((timestampMs) => {
        this.#runFrame(pending.token, timestampMs);
      });
      // A test driver may invoke the callback synchronously. Do not resurrect
      // the consumed frame when that happens.
      if (this.#pendingFrame === pending) pending.handle = handle;
    } catch (error) {
      if (this.#pendingFrame === pending) this.#pendingFrame = null;
      throw error;
    }
  }

  #cancelPendingFrame(): void {
    const pending = this.#pendingFrame;
    if (!pending) return;
    this.#pendingFrame = null;
    if (pending.handle !== null) this.#cancelFrame(pending.handle);
  }

  #runFrame(token: number, frameTimestampMs: number): void {
    const pending = this.#pendingFrame;
    if (this.#disposed || !pending || pending.token !== token) return;
    this.#pendingFrame = null;

    const nowMs = this.#now();
    const timestampMs = Number.isFinite(frameTimestampMs) ? frameTimestampMs : nowMs;
    const previousTimestampMs = this.#lastTimestampMs;
    const deltaMs =
      previousTimestampMs === null ? 0 : Math.max(0, timestampMs - previousTimestampMs);
    this.#lastTimestampMs = timestampMs;
    this.#lastDeltaMs = deltaMs;
    this.#totalTicks += 1;
    this.#isTicking = true;

    try {
      // Snapshot registration order. Existing records are checked again before
      // each callback so deactivation during an earlier callback takes effect
      // immediately, while a scene registered during this tick waits for the
      // next shared frame.
      const scenes = [...this.#scenes.values()];
      for (const scene of scenes) {
        if (this.#scenes.get(scene.name) !== scene || !this.#canRun(scene)) continue;
        const version = scene.version;
        scene.needsFrame = false;
        scene.ticks += 1;
        const needsAnotherFrame = scene.callback(timestampMs, deltaMs);

        // Lifecycle calls made from a callback own the resulting state. For
        // example, deactivate() must not be undone by a stale `true` return.
        if (this.#scenes.get(scene.name) === scene && scene.active && scene.version === version) {
          scene.needsFrame = Boolean(needsAnotherFrame);
        }
      }
    } finally {
      this.#isTicking = false;
      this.#scheduleIfNeeded();
    }
  }
}

export function createMotionScheduler(options: MotionSchedulerOptions = {}): MotionScheduler {
  return new MotionScheduler(options);
}

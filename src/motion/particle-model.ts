import { createSeededRandom } from "./random";

/** The particle field is decorative and intentionally absent at this width. */
export const PARTICLE_BREAKPOINT = 768;
/** Stable seed for replayable initialization and deterministic resize rebuilds. */
export const PARTICLE_SEED = 20260825;
/** Physics are integrated at a fixed rate and sampled at any display cadence. */
export const PARTICLE_FIXED_STEP_MS = 1000 / 60;
/** A hidden tab or debugger pause cannot cause an unbounded catch-up loop. */
export const PARTICLE_MAX_CATCH_UP_MS = 250;
/** Maximum fixed updates consumed by one adapter callback. */
export const PARTICLE_MAX_STEPS_PER_ADVANCE = Math.ceil(
  PARTICLE_MAX_CATCH_UP_MS / PARTICLE_FIXED_STEP_MS,
);
/** Distance used by the subtle desktop connection field. */
export const PARTICLE_CONNECTION_DISTANCE = 90;
/** Hard upper bound for grid candidate/distance work per physics step. */
export const PARTICLE_MAX_NEIGHBOR_CHECKS = 4096;
/** The original field used 160 small background particles on desktop. */
export const PARTICLE_COUNT = 160;

const EPSILON = 1e-8;
const MAX_SPEED = 34;
const POINTER_RADIUS = 180;
const POINTER_FORCE = 58;
const WRAP_MARGIN = 20;
const COLORS = [
  "#ffffff",
  "#ffffff",
  "#ffffff",
  "#ffffff",
  "#f8f6ff",
  "#ffffff",
  "#fff0f8",
  "#ffffff",
  "#f0f0ff",
] as const;

export type ParticlePhase = "idle" | "running" | "paused" | "settled";

export type ParticlePointer = Readonly<{
  x: number;
  y: number;
}>;

export type ParticleState = Readonly<{
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  alpha: number;
  glow: boolean;
  ageMs: number;
  maxAgeMs: number;
}>;

export type ParticleLink = Readonly<{
  a: number;
  b: number;
  distance: number;
  color: string;
}>;

export type ParticleActivityReason =
  | "running"
  | "idle"
  | "paused"
  | "settled"
  | "mobile-breakpoint"
  | "reduced-motion";

export type ParticleSnapshot = Readonly<{
  version: 1;
  seed: number;
  width: number;
  height: number;
  mobile: boolean;
  reducedMotion: boolean;
  phase: ParticlePhase;
  simulationMs: number;
  accumulatorMs: number;
  pointer: ParticlePointer | null;
  pointerRadius: number;
  pointerGlow: boolean;
  needsFrame: boolean;
  active: boolean;
  settled: boolean;
  reason: ParticleActivityReason;
  count: number;
  neighborChecks: number;
  actualNeighborChecks: number;
  totalNeighborChecks: number;
  maxNeighborChecks: number;
  maxLinks: number;
  droppedNeighborChecks: number;
  links: readonly ParticleLink[];
  particles: readonly ParticleState[];
}>;

export type ParticleSimulationOptions = Readonly<{
  width: number;
  height: number;
  /** Defaults to `width <= PARTICLE_BREAKPOINT`. */
  mobile?: boolean;
  /** Keep the model idle until an offscreen adapter starts it. */
  autoStart?: boolean;
  seed?: number;
  reducedMotion?: boolean;
  fixedStepMs?: number;
  maxCatchUpMs?: number;
  maxStepsPerAdvance?: number;
  count?: number;
  connectionDistance?: number;
  maxNeighborChecks?: number;
  maxLinks?: number;
}>;

export type ParticleAdvanceResult = Readonly<{
  elapsedMs: number;
  simulatedMs: number;
  steps: number;
  droppedMs: number;
  snapshot: ParticleSnapshot;
}>;

export type ParticleDiagnostics = Readonly<{
  version: 1;
  active: boolean;
  settled: boolean;
  count: number;
  neighborChecks: number;
  actualNeighborChecks: number;
  pairChecksPerFrame: number;
  totalNeighborChecks: number;
  maxNeighborChecks: number;
  droppedNeighborChecks: number;
  width: number;
  height: number;
  mobile: boolean;
  mobileDisabled: boolean;
  reducedMotion: boolean;
  reason: ParticleActivityReason;
  phase: ParticlePhase;
  simulationMs: number;
  needsFrame: boolean;
  pointerGlow: boolean;
}>;

type MutablePointer = { x: number; y: number };

type MutableParticle = {
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  alpha: number;
  glow: boolean;
  ageMs: number;
  maxAgeMs: number;
  generation: number;
};

type Grid = Map<string, number[]>;

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function clamp(value: number, min: number, max: number): number {
  // Tiny embedded canvases can be smaller than two particle diameters. The
  // caller still gets finite coordinates in that case by collapsing the range
  // to its midpoint rather than returning an inverted interval.
  if (max < min) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function copyPointer(pointer: MutablePointer | null): ParticlePointer | null {
  return pointer ? { x: pointer.x, y: pointer.y } : null;
}

function gridKey(x: number, y: number): string {
  return `${x},${y}`;
}

function hashUnit(seed: number, index: number, generation: number, salt: number): number {
  let value = seed >>> 0;
  value = Math.imul(value ^ Math.imul(index + 1, 0x9e3779b9), 0x85ebca6b);
  value = Math.imul(value ^ Math.imul(generation + 1, 0xc2b2ae35), 0x27d4eb2d);
  value = Math.imul(value ^ Math.imul(salt + 1, 0x165667b1), 0x9e3779b1);
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  return (value >>> 0) / 4294967296;
}

function stableNoise(seed: number, index: number, simulationMs: number, fixedStepMs: number): number {
  // Quantizing the time to fixed-step units makes the tiny drift identical
  // regardless of how often the renderer samples the model.
  const step = Math.round(simulationMs / fixedStepMs);
  const phase = hashUnit(seed, index, step, 41) * Math.PI * 2;
  return Math.sin(phase);
}

/**
 * Pure deterministic state for the desktop particle field.
 *
 * The class owns no browser objects, clocks, or animation frames. The browser
 * adapter supplies elapsed time and paints `snapshot().particles`/`links`.
 */
export class ParticleSimulation {
  readonly #seed: number;
  readonly #fixedStepMs: number;
  readonly #maxCatchUpMs: number;
  readonly #maxStepsPerAdvance: number;
  readonly #count: number;
  readonly #connectionDistance: number;
  readonly #maxNeighborChecks: number;
  readonly #maxLinks: number;

  #width: number;
  #height: number;
  #mobile: boolean;
  #reducedMotion: boolean;
  #phase: ParticlePhase = "idle";
  #resumePhase: ParticlePhase = "running";
  #simulationMs = 0;
  #accumulatorMs = 0;
  #pointer: MutablePointer | null = null;
  #particles: MutableParticle[] = [];
  #links: ParticleLink[] = [];
  #neighborChecks = 0;
  #totalNeighborChecks = 0;
  #droppedNeighborChecks = 0;

  constructor(options: ParticleSimulationOptions) {
    assertFinitePositive("ParticleSimulation width", options.width);
    assertFinitePositive("ParticleSimulation height", options.height);

    const seed = options.seed ?? PARTICLE_SEED;
    if (!Number.isInteger(seed)) throw new TypeError("ParticleSimulation seed must be an integer");

    const fixedStepMs = options.fixedStepMs ?? PARTICLE_FIXED_STEP_MS;
    assertFinitePositive("ParticleSimulation fixedStepMs", fixedStepMs);
    const maxCatchUpMs = options.maxCatchUpMs ?? PARTICLE_MAX_CATCH_UP_MS;
    assertFinitePositive("ParticleSimulation maxCatchUpMs", maxCatchUpMs);
    const maxStepsPerAdvance =
      options.maxStepsPerAdvance ?? Math.ceil(maxCatchUpMs / fixedStepMs);
    assertPositiveInteger("ParticleSimulation maxStepsPerAdvance", maxStepsPerAdvance);

    const count = options.count ?? PARTICLE_COUNT;
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("ParticleSimulation count must be a non-negative integer");
    }
    const connectionDistance = options.connectionDistance ?? PARTICLE_CONNECTION_DISTANCE;
    assertFinitePositive("ParticleSimulation connectionDistance", connectionDistance);
    const maxNeighborChecks = options.maxNeighborChecks ?? PARTICLE_MAX_NEIGHBOR_CHECKS;
    assertPositiveInteger("ParticleSimulation maxNeighborChecks", maxNeighborChecks);
    const maxLinks = options.maxLinks ?? maxNeighborChecks;
    assertPositiveInteger("ParticleSimulation maxLinks", maxLinks);

    this.#seed = seed;
    this.#fixedStepMs = fixedStepMs;
    this.#maxCatchUpMs = maxCatchUpMs;
    this.#maxStepsPerAdvance = maxStepsPerAdvance;
    this.#count = count;
    this.#connectionDistance = connectionDistance;
    this.#maxNeighborChecks = maxNeighborChecks;
    this.#maxLinks = Math.min(maxLinks, maxNeighborChecks);
    this.#width = options.width;
    this.#height = options.height;
    this.#mobile = options.mobile ?? options.width <= PARTICLE_BREAKPOINT;
    this.#reducedMotion = options.reducedMotion ?? false;

    if (options.autoStart === false) {
      this.#phase = this.#isDisabled() ? "settled" : "idle";
    } else {
      this.#initialize();
    }
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get mobile(): boolean {
    return this.#mobile;
  }

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  get phase(): ParticlePhase {
    return this.#phase;
  }

  get settled(): boolean {
    return this.#phase === "settled";
  }

  get needsFrame(): boolean {
    return this.#phase === "running";
  }

  get simulationMs(): number {
    return this.#simulationMs;
  }

  get particleCount(): number {
    return this.#particles.length;
  }

  get maxNeighborChecks(): number {
    return this.#maxNeighborChecks;
  }

  /** Starts the perpetual desktop drift, or leaves disabled models settled. */
  start(): ParticleSnapshot {
    if (this.#phase === "idle" || this.#phase === "settled") this.#initialize();
    else if (this.#phase === "paused") this.resume();
    return this.snapshot();
  }

  /** Rebuilds the same seeded field while retaining dimensions and policy. */
  restart(): ParticleSnapshot {
    this.#initialize();
    return this.snapshot();
  }

  pause(): ParticleSnapshot {
    if (this.needsFrame) {
      this.#resumePhase = this.#phase;
      this.#phase = "paused";
    }
    return this.snapshot();
  }

  resume(): ParticleSnapshot {
    if (this.#phase !== "paused") return this.snapshot();
    this.#phase = this.#isDisabled() ? "settled" : this.#resumePhase;
    if (this.#phase === "idle" && !this.#isDisabled()) this.#phase = "running";
    return this.snapshot();
  }

  setReducedMotion(reducedMotion: boolean): ParticleSnapshot {
    if (this.#reducedMotion === reducedMotion) return this.snapshot();
    this.#reducedMotion = reducedMotion;
    this.#initialize();
    return this.snapshot();
  }

  setPointer(x: number, y: number): ParticleSnapshot {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError("ParticleSimulation pointer coordinates must be finite");
    }
    this.#pointer = { x, y };
    return this.snapshot();
  }

  clearPointer(): ParticleSnapshot {
    this.#pointer = null;
    return this.snapshot();
  }

  /**
   * Resizes in CSS-pixel coordinates. Same-mode resizes map the current field;
   * crossing the desktop/mobile policy rebuilds a deterministic field.
   */
  resize(width: number, height: number, mobile = width <= PARTICLE_BREAKPOINT): ParticleSnapshot {
    assertFinitePositive("ParticleSimulation width", width);
    assertFinitePositive("ParticleSimulation height", height);

    const oldWidth = this.#width;
    const oldHeight = this.#height;
    const crossedMode = mobile !== this.#mobile;
    const mappedPointer = this.#pointer
      ? { x: this.#pointer.x * (width / oldWidth), y: this.#pointer.y * (height / oldHeight) }
      : null;
    const wasIdle = this.#phase === "idle";
    const wasPaused = this.#phase === "paused";

    this.#width = width;
    this.#height = height;
    this.#mobile = mobile;

    if (crossedMode) {
      this.#initialize();
      this.#pointer = mappedPointer;
      if (wasIdle && !this.#isDisabled()) {
        this.#phase = "idle";
        this.#particles = [];
        this.#links = [];
      }
      if (wasPaused && this.#phase === "running") this.#phase = "paused";
      return this.snapshot();
    }

    const xScale = width / oldWidth;
    const yScale = height / oldHeight;
    this.#particles.forEach((particle) => {
      particle.x *= xScale;
      particle.y *= yScale;
      this.#clampParticle(particle);
    });
    if (this.#pointer) {
      this.#pointer.x *= xScale;
      this.#pointer.y *= yScale;
    }
    this.#rebuildLinks();
    return this.snapshot();
  }

  /** Advances elapsed wall time using a fixed-step integrator with a hard cap. */
  advance(elapsedMs: number): ParticleAdvanceResult {
    assertFiniteNonNegative("ParticleSimulation elapsedMs", elapsedMs);
    const boundedElapsed = Math.min(elapsedMs, this.#maxCatchUpMs);
    const droppedMs = elapsedMs - boundedElapsed;

    if (!this.needsFrame || boundedElapsed === 0) {
      return {
        elapsedMs,
        simulatedMs: 0,
        steps: 0,
        droppedMs,
        snapshot: this.snapshot(),
      };
    }

    this.#accumulatorMs = Math.min(this.#maxCatchUpMs, this.#accumulatorMs + boundedElapsed);
    let steps = 0;
    while (
      this.#accumulatorMs + EPSILON >= this.#fixedStepMs &&
      steps < this.#maxStepsPerAdvance &&
      this.needsFrame
    ) {
      this.#accumulatorMs -= this.#fixedStepMs;
      if (this.#accumulatorMs < EPSILON) this.#accumulatorMs = 0;
      this.#tick();
      steps += 1;
    }
    if (Math.abs(this.#accumulatorMs) < EPSILON) this.#accumulatorMs = 0;

    return {
      elapsedMs,
      simulatedMs: Math.min(steps * this.#fixedStepMs, this.#maxCatchUpMs),
      steps,
      droppedMs,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): ParticleSnapshot {
    const reason = this.#reason();
    const particles = this.#particles.map((particle) => ({
      index: particle.index,
      x: particle.x,
      y: particle.y,
      vx: particle.vx,
      vy: particle.vy,
      r: particle.r,
      color: particle.color,
      alpha: particle.alpha,
      glow: particle.glow,
      ageMs: particle.ageMs,
      maxAgeMs: particle.maxAgeMs,
    }));
    const links = this.#links.map((link) => ({ ...link }));
    const active = this.needsFrame;
    return {
      version: 1,
      seed: this.#seed,
      width: this.#width,
      height: this.#height,
      mobile: this.#mobile,
      reducedMotion: this.#reducedMotion,
      phase: this.#phase,
      simulationMs: this.#simulationMs,
      accumulatorMs: this.#accumulatorMs,
      pointer: copyPointer(this.#pointer),
      pointerRadius: POINTER_RADIUS,
      pointerGlow: this.#pointer !== null,
      needsFrame: active,
      active,
      settled: this.settled,
      reason,
      count: particles.length,
      neighborChecks: this.#neighborChecks,
      actualNeighborChecks: this.#neighborChecks,
      totalNeighborChecks: this.#totalNeighborChecks,
      maxNeighborChecks: this.#maxNeighborChecks,
      maxLinks: this.#maxLinks,
      droppedNeighborChecks: this.#droppedNeighborChecks,
      links,
      particles,
    };
  }

  diagnostics(): ParticleDiagnostics {
    const snapshot = this.snapshot();
    return {
      version: 1,
      active: snapshot.active,
      settled: snapshot.settled,
      count: snapshot.count,
      neighborChecks: snapshot.neighborChecks,
      actualNeighborChecks: snapshot.actualNeighborChecks,
      pairChecksPerFrame: snapshot.neighborChecks,
      totalNeighborChecks: snapshot.totalNeighborChecks,
      maxNeighborChecks: snapshot.maxNeighborChecks,
      droppedNeighborChecks: snapshot.droppedNeighborChecks,
      width: snapshot.width,
      height: snapshot.height,
      mobile: snapshot.mobile,
      mobileDisabled: snapshot.mobile,
      reducedMotion: snapshot.reducedMotion,
      reason: snapshot.reason,
      phase: snapshot.phase,
      simulationMs: snapshot.simulationMs,
      needsFrame: snapshot.needsFrame,
      pointerGlow: snapshot.pointerGlow,
    };
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  toJSON(): ParticleSnapshot {
    return this.snapshot();
  }

  #isDisabled(): boolean {
    return this.#mobile || this.#reducedMotion;
  }

  #reason(): ParticleActivityReason {
    if (this.#mobile) return "mobile-breakpoint";
    if (this.#reducedMotion) return "reduced-motion";
    if (this.#phase === "running") return "running";
    if (this.#phase === "paused") return "paused";
    if (this.#phase === "idle") return "idle";
    return "settled";
  }

  #initialize(): void {
    this.#simulationMs = 0;
    this.#accumulatorMs = 0;
    this.#neighborChecks = 0;
    this.#totalNeighborChecks = 0;
    this.#droppedNeighborChecks = 0;
    this.#links = [];

    if (this.#isDisabled()) {
      this.#particles = [];
      this.#phase = "settled";
      return;
    }

    // Keep the random stream local to initialization. Respawns use a pure
    // hash, so the same input sequence never depends on prior frame sampling.
    const random = createSeededRandom(this.#seed);
    this.#particles = Array.from({ length: this.#count }, (_, index) => {
      const particle: MutableParticle = {
        index,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: 0.2,
        color: COLORS[0],
        alpha: 0.25,
        glow: false,
        ageMs: 0,
        maxAgeMs: 600_000,
        generation: 0,
      };
      this.#seedParticle(particle, random);
      return particle;
    });
    this.#phase = "running";
    this.#rebuildLinks();
  }

  #seedParticle(particle: MutableParticle, random?: () => number): void {
    const next = random ?? (() => hashUnit(this.#seed, particle.index, particle.generation, 1));
    const randomValue = (salt: number): number =>
      random ? random() : hashUnit(this.#seed, particle.index, particle.generation, salt);
    const maxRadius = Math.max(EPSILON, Math.min(1.2, this.#width * 0.49, this.#height * 0.49));
    particle.r = Math.max(EPSILON, Math.min(maxRadius, 0.2 + randomValue(2)));
    particle.x = randomValue(3) * this.#width;
    particle.y = randomValue(4) * this.#height;
    particle.vx = (randomValue(5) - 0.5) * 24;
    particle.vy = (randomValue(6) - 0.5) * 24;
    particle.color = COLORS[Math.min(COLORS.length - 1, Math.floor(randomValue(7) * COLORS.length))];
    particle.alpha = 0.25 + randomValue(8) * 0.45;
    particle.glow = randomValue(9) > 0.65;
    particle.ageMs = 0;
    particle.maxAgeMs = 10_000 + randomValue(10) * 13_000;
    this.#clampParticle(particle);
    // Keep `next` referenced so a supplied source is validated by execution
    // while preserving the concise pure-hash respawn path above.
    void next;
  }

  #respawnParticle(particle: MutableParticle): void {
    particle.generation += 1;
    const edge = hashUnit(this.#seed, particle.index, particle.generation, 11);
    const xOrY = hashUnit(this.#seed, particle.index, particle.generation, 12);
    const maxRadius = Math.max(EPSILON, Math.min(1.2, this.#width * 0.49, this.#height * 0.49));
    particle.r = Math.max(EPSILON, Math.min(maxRadius, 0.2 + hashUnit(this.#seed, particle.index, particle.generation, 13)));
    particle.color = COLORS[Math.min(COLORS.length - 1, Math.floor(hashUnit(this.#seed, particle.index, particle.generation, 14) * COLORS.length))];
    particle.alpha = 0.25 + hashUnit(this.#seed, particle.index, particle.generation, 15) * 0.45;
    particle.glow = hashUnit(this.#seed, particle.index, particle.generation, 16) > 0.65;
    particle.maxAgeMs = 10_000 + hashUnit(this.#seed, particle.index, particle.generation, 17) * 13_000;
    particle.ageMs = 0;
    particle.vx = (hashUnit(this.#seed, particle.index, particle.generation, 18) - 0.5) * 24;
    particle.vy = (hashUnit(this.#seed, particle.index, particle.generation, 19) - 0.5) * 24;
    if (edge < 0.5) {
      particle.x = edge < 0.25 ? particle.r : this.#width - particle.r;
      particle.y = xOrY * this.#height;
    } else {
      particle.x = xOrY * this.#width;
      particle.y = edge < 0.75 ? particle.r : this.#height - particle.r;
    }
    this.#clampParticle(particle);
  }

  #clampParticle(particle: MutableParticle): void {
    const xMin = particle.r;
    const xMax = this.#width - particle.r;
    const yMin = particle.r;
    const yMax = this.#height - particle.r;
    particle.x = clamp(finiteOr(particle.x, this.#width / 2), xMin, xMax);
    particle.y = clamp(finiteOr(particle.y, this.#height / 2), yMin, yMax);
    particle.vx = clamp(finiteOr(particle.vx, 0), -MAX_SPEED, MAX_SPEED);
    particle.vy = clamp(finiteOr(particle.vy, 0), -MAX_SPEED, MAX_SPEED);
  }

  #tick(): void {
    const dtSeconds = this.#fixedStepMs / 1000;
    this.#simulationMs += this.#fixedStepMs;

    for (const particle of this.#particles) {
      const drift = stableNoise(this.#seed, particle.index, this.#simulationMs, this.#fixedStepMs);
      particle.vx += Math.cos(drift * Math.PI) * 0.9 * dtSeconds;
      particle.vy += Math.sin(drift * Math.PI * 1.7) * 0.9 * dtSeconds;

      if (this.#pointer) {
        const dx = particle.x - this.#pointer.x;
        const dy = particle.y - this.#pointer.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < POINTER_RADIUS * POINTER_RADIUS) {
          const distance = Math.sqrt(distanceSquared);
          const inverseDistance = distance > EPSILON ? 1 / distance : 0;
          const falloff = 1 - distance / POINTER_RADIUS;
          const force = POINTER_FORCE * falloff * falloff * dtSeconds;
          const normalX = distance > EPSILON ? dx * inverseDistance : (particle.index % 2 ? 1 : -1);
          const normalY = distance > EPSILON ? dy * inverseDistance : 0;
          particle.vx += normalX * force;
          particle.vy += normalY * force;
        }
      }

      const damping = Math.pow(0.985, this.#fixedStepMs / PARTICLE_FIXED_STEP_MS);
      particle.vx *= damping;
      particle.vy *= damping;
      const speed = Math.hypot(particle.vx, particle.vy);
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        particle.vx *= scale;
        particle.vy *= scale;
      }

      particle.x += particle.vx * dtSeconds;
      particle.y += particle.vy * dtSeconds;
      particle.ageMs += this.#fixedStepMs;
      if (particle.ageMs > particle.maxAgeMs) this.#respawnParticle(particle);

      // Keep the canvas field bounded while preserving the original edge-wrap
      // feel. A respawn is deterministic and never leaves an out-of-range
      // coordinate in a public snapshot.
      if (particle.x < -WRAP_MARGIN) particle.x = this.#width - particle.r;
      else if (particle.x > this.#width + WRAP_MARGIN) particle.x = particle.r;
      if (particle.y < -WRAP_MARGIN) particle.y = this.#height - particle.r;
      else if (particle.y > this.#height + WRAP_MARGIN) particle.y = particle.r;
      this.#clampParticle(particle);
    }

    this.#rebuildLinks();
  }

  #rebuildLinks(): void {
    const cellSize = this.#connectionDistance;
    const grid: Grid = new Map();
    for (const particle of this.#particles) {
      const cellX = Math.floor(particle.x / cellSize);
      const cellY = Math.floor(particle.y / cellSize);
      const key = gridKey(cellX, cellY);
      const occupants = grid.get(key);
      if (occupants) occupants.push(particle.index);
      else grid.set(key, [particle.index]);
    }

    let checks = 0;
    let dropped = 0;
    const links: ParticleLink[] = [];
    const maxDistanceSquared = this.#connectionDistance * this.#connectionDistance;

    outer: for (const particle of this.#particles) {
      const cellX = Math.floor(particle.x / cellSize);
      const cellY = Math.floor(particle.y / cellSize);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const occupants = grid.get(gridKey(cellX + offsetX, cellY + offsetY));
          if (!occupants) continue;
          for (const otherIndex of occupants) {
            if (otherIndex <= particle.index) continue;
            if (checks >= this.#maxNeighborChecks) {
              dropped += 1;
              break outer;
            }
            checks += 1;
            const other = this.#particles[otherIndex];
            if (!other) continue;
            const dx = particle.x - other.x;
            const dy = particle.y - other.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared >= maxDistanceSquared) continue;
            const distance = Math.sqrt(distanceSquared);
            if (links.length >= this.#maxLinks) continue;
            links.push({
              a: particle.index,
              b: other.index,
              distance,
              color: particle.color,
            });
          }
        }
      }
      if (checks >= this.#maxNeighborChecks && links.length >= this.#maxLinks) break outer;
    }

    this.#neighborChecks = checks;
    this.#totalNeighborChecks += checks;
    this.#droppedNeighborChecks = dropped;
    this.#links = links;
  }
}

/** Alias kept for callers that use “model” rather than “simulation”. */
export { ParticleSimulation as ParticleModel };

export function createParticleModel(options: ParticleSimulationOptions): ParticleSimulation {
  return new ParticleSimulation(options);
}

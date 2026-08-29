import { createSeededRandom } from "./random";

/** The seed is part of the visual contract: the same model is replayable. */
export const SKILLS_SEED = 20260825;
export const SKILLS_BREAKPOINT = 768;
export const SKILLS_FIXED_STEP_MS = 1000 / 60;
export const SKILLS_MAX_CATCH_UP_MS = 250;
export const SKILLS_EXPLOSION_MS = 1200;
export const SKILLS_SETTLE_QUIET_MS = 300;
export const SKILLS_SETTLE_DEADLINE_MS = 10_000;

const EPSILON = 1e-8;

export type SkillsPhase = "idle" | "entering" | "running" | "settled" | "paused";

export type SkillDefinition = Readonly<{
  label: string;
  svg: string;
  radius: number;
}>;

/**
 * The ordering is intentional. Mobile uses the first ten skills and desktop
 * uses all fifteen, matching the original canvas scene.
 */
export const SKILL_DEFINITIONS: readonly SkillDefinition[] = [
  { label: "Figma", svg: "icon/figma.svg", radius: 64 },
  { label: "UX Research", svg: "icon/ux-research.svg", radius: 60 },
  { label: "Prototyping", svg: "icon/Frame.svg", radius: 55 },
  { label: "Design Systems", svg: "icon/design-systems.svg", radius: 58 },
  { label: "User Testing", svg: "icon/user-testing.svg", radius: 52 },
  { label: "Motion Design", svg: "icon/motion-design.svg", radius: 56 },
  { label: "AI Generation", svg: "icon/ai-generation.svg", radius: 58 },
  { label: "Photoshop", svg: "icon/photoshop.svg", radius: 50 },
  { label: "Illustrator", svg: "icon/illustrator.svg", radius: 48 },
  { label: "InDesign", svg: "icon/InDesign.svg", radius: 48 },
  { label: "HTML & CSS", svg: "icon/html-css.svg", radius: 44 },
  { label: "Miro", svg: "icon/miro.svg", radius: 44 },
  { label: "Brainstorm", svg: "icon/brainstorm.svg", radius: 52 },
  { label: "Typography", svg: "icon/typography.svg", radius: 46 },
  { label: "UI Design", svg: "icon/ui.svg", radius: 54 },
];

export type SkillsPointer = Readonly<{
  x: number;
  y: number;
}>;

export type SkillsChipSnapshot = Readonly<{
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

export type SkillsSnapshot = Readonly<{
  version: 1;
  seed: number;
  width: number;
  height: number;
  mobile: boolean;
  reducedMotion: boolean;
  phase: SkillsPhase;
  simulationMs: number;
  accumulatorMs: number;
  pointer: SkillsPointer | null;
  exploding: boolean;
  settled: boolean;
  needsFrame: boolean;
  chips: readonly SkillsChipSnapshot[];
}>;

export type SkillsSimulationOptions = Readonly<{
  width: number;
  height: number;
  /** Defaults to width <= SKILLS_BREAKPOINT. */
  mobile?: boolean;
  /** Keep the model idle until start/restart when the scene is offscreen. */
  autoStart?: boolean;
  seed?: number;
  reducedMotion?: boolean;
  fixedStepMs?: number;
  maxCatchUpMs?: number;
  maxStepsPerAdvance?: number;
}>;

export type SkillsAdvanceResult = Readonly<{
  elapsedMs: number;
  simulatedMs: number;
  steps: number;
  droppedMs: number;
  snapshot: SkillsSnapshot;
}>;

type MutablePointer = { x: number; y: number };

type MutableChip = {
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
};

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function stablePairAngle(a: number, b: number): number {
  // A deterministic normal is needed when two chips begin at exactly the same
  // point. The mixed pair coefficients avoid obvious row/column alignment.
  return ((a * 37 + b * 17 + 11) % 360) * (Math.PI / 180);
}

function copyPointer(pointer: MutablePointer | null): SkillsPointer | null {
  return pointer ? { x: pointer.x, y: pointer.y } : null;
}

/**
 * Pure, deterministic state for the Tools & Skills canvas.
 *
 * This class deliberately knows nothing about a DOM, canvas, animation frame,
 * or wall clock. An adapter owns those concerns and calls `advance`, `resize`,
 * and the pointer methods, then paints `snapshot().chips`.
 */
export class SkillsSimulation {
  readonly #seed: number;
  readonly #fixedStepMs: number;
  readonly #maxCatchUpMs: number;
  readonly #maxStepsPerAdvance: number;

  #width: number;
  #height: number;
  #mobile: boolean;
  #reducedMotion: boolean;
  #phase: SkillsPhase = "idle";
  #resumePhase: SkillsPhase = "running";
  #simulationMs = 0;
  #accumulatorMs = 0;
  #quietMs = 0;
  #pointer: MutablePointer | null = null;
  #chips: MutableChip[] = [];

  constructor(options: SkillsSimulationOptions) {
    assertFinitePositive("SkillsSimulation width", options.width);
    assertFinitePositive("SkillsSimulation height", options.height);

    const seed = options.seed ?? SKILLS_SEED;
    if (!Number.isInteger(seed)) throw new TypeError("SkillsSimulation seed must be an integer");

    const fixedStepMs = options.fixedStepMs ?? SKILLS_FIXED_STEP_MS;
    assertFinitePositive("SkillsSimulation fixedStepMs", fixedStepMs);

    const maxCatchUpMs = options.maxCatchUpMs ?? SKILLS_MAX_CATCH_UP_MS;
    assertFinitePositive("SkillsSimulation maxCatchUpMs", maxCatchUpMs);

    const maxStepsPerAdvance = options.maxStepsPerAdvance ?? Math.ceil(maxCatchUpMs / fixedStepMs);
    if (!Number.isInteger(maxStepsPerAdvance) || maxStepsPerAdvance <= 0) {
      throw new RangeError("SkillsSimulation maxStepsPerAdvance must be a positive integer");
    }

    this.#seed = seed;
    this.#fixedStepMs = fixedStepMs;
    this.#maxCatchUpMs = maxCatchUpMs;
    this.#maxStepsPerAdvance = maxStepsPerAdvance;
    this.#width = options.width;
    this.#height = options.height;
    this.#mobile = options.mobile ?? options.width <= SKILLS_BREAKPOINT;
    this.#reducedMotion = options.reducedMotion ?? false;
    if (options.autoStart === false) this.#phase = "idle";
    else this.#initialize();
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

  get phase(): SkillsPhase {
    return this.#phase;
  }

  get settled(): boolean {
    return this.#phase === "settled";
  }

  /** Whether an adapter should keep its shared animation scheduler alive. */
  get needsFrame(): boolean {
    return this.#phase === "entering" || this.#phase === "running";
  }

  get simulationMs(): number {
    return this.#simulationMs;
  }

  get chipCount(): number {
    return this.#chips.length;
  }

  /** Start or restart the deterministic explosion. */
  start(): SkillsSnapshot {
    if (this.#phase === "idle" || this.#phase === "settled") this.#initialize();
    else if (this.#phase === "paused") this.resume();
    return this.snapshot();
  }

  /** Rebuild from the original seed while retaining the current dimensions. */
  restart(): SkillsSnapshot {
    this.#initialize();
    return this.snapshot();
  }

  pause(): SkillsSnapshot {
    if (this.needsFrame) {
      this.#resumePhase = this.#phase;
      this.#phase = "paused";
    }
    return this.snapshot();
  }

  resume(): SkillsSnapshot {
    if (this.#phase !== "paused") return this.snapshot();
    this.#phase = this.#reducedMotion ? "settled" : this.#resumePhase;
    if (this.#phase === "idle") this.#phase = "running";
    return this.snapshot();
  }

  /**
   * Switch the reduced-motion policy. Reduced motion is a settled model: all
   * content remains painted, but no decorative physics or frame scheduling is
   * required.
   */
  setReducedMotion(reducedMotion: boolean): SkillsSnapshot {
    if (this.#reducedMotion === reducedMotion) return this.snapshot();
    this.#reducedMotion = reducedMotion;
    if (this.#phase !== "idle") this.#initialize();
    return this.snapshot();
  }

  setPointer(x: number, y: number): SkillsSnapshot {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError("SkillsSimulation pointer coordinates must be finite");
    }
    this.#pointer = { x, y };
    if (this.#phase === "settled" && !this.#reducedMotion) {
      this.#quietMs = 0;
      this.#phase = "running";
    }
    return this.snapshot();
  }

  clearPointer(): SkillsSnapshot {
    this.#pointer = null;
    return this.snapshot();
  }

  /**
   * Resize in CSS-pixel coordinates. Same-breakpoint changes map the current
   * state proportionally; crossing the mobile breakpoint intentionally
   * rebuilds the model so its count and scale are deterministic.
   */
  resize(width: number, height: number, mobile = width <= SKILLS_BREAKPOINT): SkillsSnapshot {
    assertFinitePositive("SkillsSimulation width", width);
    assertFinitePositive("SkillsSimulation height", height);

    const oldWidth = this.#width;
    const oldHeight = this.#height;
    const crossedBreakpoint = mobile !== this.#mobile;
    const wasPaused = this.#phase === "paused";
    const wasIdle = this.#phase === "idle";
    const mappedPointer = this.#pointer
      ? { x: this.#pointer.x * (width / oldWidth), y: this.#pointer.y * (height / oldHeight) }
      : null;

    this.#width = width;
    this.#height = height;
    this.#mobile = mobile;

    if (crossedBreakpoint) {
      this.#initialize();
      this.#pointer = mappedPointer;
      if (wasIdle) {
        this.#phase = "idle";
        this.#chips = [];
      }
      if (wasPaused && this.needsFrame) {
        this.#resumePhase = this.#phase;
        this.#phase = "paused";
      }
      return this.snapshot();
    }

    const xScale = width / oldWidth;
    const yScale = height / oldHeight;
    const desiredScale = this.#mobile ? 0.8 : 1.22;
    const maxCanvasRadius = Math.min(width, height) * 0.49;
    this.#chips.forEach((chip) => {
      // A same-breakpoint resize can still make an embedded canvas narrower
      // than its old chips. Shrink only as much as needed to keep every chip
      // representable; ordinary responsive resizes retain the original scale.
      const definition = SKILL_DEFINITIONS[chip.index];
      chip.r = Math.max(
        Number.EPSILON,
        Math.min(definition.radius * desiredScale, maxCanvasRadius),
      );
      chip.x *= xScale;
      chip.y *= yScale;
      chip.targetX *= xScale;
      chip.targetY *= yScale;
      this.#clampChip(chip);
      chip.targetX = clamp(chip.targetX, chip.r, width - chip.r);
      chip.targetY = clamp(chip.targetY, chip.r, height - chip.r);
    });
    if (this.#pointer) {
      this.#pointer.x *= xScale;
      this.#pointer.y *= yScale;
    }
    return this.snapshot();
  }

  /**
   * Advance by elapsed wall-clock time. At most maxCatchUpMs and
   * maxStepsPerAdvance are consumed per call, preventing a hidden tab or a
   * debugger pause from causing an unbounded synchronous catch-up loop.
   */
  advance(elapsedMs: number): SkillsAdvanceResult {
    assertFiniteNonNegative("SkillsSimulation elapsedMs", elapsedMs);
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
    const simulatedMs = Math.min(steps * this.#fixedStepMs, this.#maxCatchUpMs);
    return {
      elapsedMs,
      simulatedMs,
      steps,
      droppedMs,
      snapshot: this.snapshot(),
    };
  }

  /** A deep, JSON-safe view for diagnostics and canvas adapters. */
  snapshot(): SkillsSnapshot {
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
      exploding: this.#phase === "entering",
      settled: this.settled,
      needsFrame: this.needsFrame,
      chips: this.#chips.map((chip) => ({ ...chip })),
    };
  }

  /** Allows JSON.stringify(simulation) without leaking mutable internals. */
  toJSON(): SkillsSnapshot {
    return this.snapshot();
  }

  /** Explicitly named for callers that persist a diagnostics snapshot. */
  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  #initialize(): void {
    const random = createSeededRandom(this.#seed);
    const definitions = this.#mobile ? SKILL_DEFINITIONS.slice(0, 10) : SKILL_DEFINITIONS;
    const scale = this.#mobile ? 0.8 : 1.22;
    const columns = Math.ceil(Math.sqrt((definitions.length * this.#width) / this.#height));
    const rows = Math.ceil(definitions.length / columns);
    const cellWidth = this.#width / columns;
    const cellHeight = this.#height / rows;
    // Keep the original visual scale in normal canvases while retaining a
    // safe inner margin for narrow test/embedded canvases.
    const maxCanvasRadius = Math.min(this.#width, this.#height) * 0.49;
    const centerX = this.#width / 2;
    const centerY = this.#height / 2;

    this.#chips = definitions.map((definition, index) => {
      const radius = Math.max(Number.EPSILON, Math.min(definition.radius * scale, maxCanvasRadius));
      const column = index % columns;
      const row = Math.floor(index / columns);
      const jitterX = (random() - 0.5) * cellWidth * 0.18;
      const jitterY = (random() - 0.5) * cellHeight * 0.18;
      const targetX = clamp((column + 0.5) * cellWidth + jitterX, radius, this.#width - radius);
      const targetY = clamp((row + 0.5) * cellHeight + jitterY, radius, this.#height - radius);
      const dx = targetX - centerX;
      const dy = targetY - centerY;
      const distance = Math.hypot(dx, dy) || 1;
      const speed = 190 + random() * 90;

      return {
        index,
        label: definition.label,
        svg: definition.svg,
        r: radius,
        x: this.#reducedMotion ? targetX : centerX,
        y: this.#reducedMotion ? targetY : centerY,
        vx: this.#reducedMotion ? 0 : (dx / distance) * speed,
        vy: this.#reducedMotion ? 0 : (dy / distance) * speed,
        targetX,
        targetY,
      };
    });

    this.#resolveTargetOverlaps();
    this.#simulationMs = 0;
    this.#accumulatorMs = 0;
    this.#quietMs = 0;
    this.#phase = this.#reducedMotion ? "settled" : "entering";
    this.#resumePhase = "running";
  }

  #resolveTargetOverlaps(): void {
    // The grid and conservative radius cap normally make this a no-op. A few
    // bounded passes handle random jitter and very narrow test canvases while
    // retaining deterministic layout.
    for (let pass = 0; pass < 12; pass += 1) {
      let moved = false;
      for (let i = 0; i < this.#chips.length; i += 1) {
        for (let j = i + 1; j < this.#chips.length; j += 1) {
          const a = this.#chips[i];
          const b = this.#chips[j];
          let dx = b.targetX - a.targetX;
          let dy = b.targetY - a.targetY;
          let distance = Math.hypot(dx, dy);
          const minimum = a.r + b.r;
          if (distance >= minimum - EPSILON) continue;
          if (distance < EPSILON) {
            const angle = stablePairAngle(a.index, b.index);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          const correction = (minimum - distance) / 2;
          const nx = dx / distance;
          const ny = dy / distance;
          a.targetX -= nx * correction;
          a.targetY -= ny * correction;
          b.targetX += nx * correction;
          b.targetY += ny * correction;
          a.targetX = clamp(a.targetX, a.r, this.#width - a.r);
          a.targetY = clamp(a.targetY, a.r, this.#height - a.r);
          b.targetX = clamp(b.targetX, b.r, this.#width - b.r);
          b.targetY = clamp(b.targetY, b.r, this.#height - b.r);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  #tick(): void {
    const dt = this.#fixedStepMs / 1000;
    this.#simulationMs += this.#fixedStepMs;
    const entering = this.#phase === "entering" && this.#simulationMs < SKILLS_EXPLOSION_MS;

    if (this.#phase === "entering" && !entering) this.#phase = "running";

    for (const chip of this.#chips) {
      if (!entering) {
        // A critically damped target spring gives the post-explosion model a
        // visible settling motion without injecting unbounded random drift.
        const targetDx = chip.targetX - chip.x;
        const targetDy = chip.targetY - chip.y;
        const spring = 12;
        chip.vx += targetDx * spring * dt;
        chip.vy += targetDy * spring * dt;
        this.#applyPointerRepulsion(chip, dt);
      }

      const damping = entering ? 0.94 : 0.82;
      const dampingPerStep = Math.pow(damping, dt / (1 / 60));
      chip.vx *= dampingPerStep;
      chip.vy *= dampingPerStep;

      const speed = Math.hypot(chip.vx, chip.vy);
      const speedCap = entering ? 460 : 280;
      if (speed > speedCap) {
        chip.vx *= speedCap / speed;
        chip.vy *= speedCap / speed;
      }

      chip.x += chip.vx * dt;
      chip.y += chip.vy * dt;
      this.#bounceOffWalls(chip);
    }

    // A small fixed number of passes is deterministic and prevents one dense
    // cluster from consuming an unbounded amount of work in a single tick.
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < this.#chips.length; i += 1) {
        for (let j = i + 1; j < this.#chips.length; j += 1) {
          this.#resolveCollision(this.#chips[i], this.#chips[j]);
        }
      }
      for (const chip of this.#chips) this.#clampChip(chip);
    }

    this.#sanitizeChips();
    this.#maybeSettle();
  }

  #applyPointerRepulsion(chip: MutableChip, dt: number): void {
    if (!this.#pointer) return;
    let dx = chip.x - this.#pointer.x;
    let dy = chip.y - this.#pointer.y;
    let distance = Math.hypot(dx, dy);
    const range = chip.r * 4.2;
    if (distance >= range) return;
    if (distance < EPSILON) {
      const angle = stablePairAngle(chip.index, chip.index + 19);
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    const normalizedDistance = distance;
    const falloff = 1 - Math.min(distance, range) / range;
    const acceleration = 220 * falloff * falloff;
    chip.vx += (dx / normalizedDistance) * acceleration * dt;
    chip.vy += (dy / normalizedDistance) * acceleration * dt;
  }

  #resolveCollision(a: MutableChip, b: MutableChip): void {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distance = Math.hypot(dx, dy);
    const minimum = a.r + b.r;
    if (distance >= minimum - EPSILON) return;
    if (distance < EPSILON) {
      const angle = stablePairAngle(a.index, b.index);
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }

    const nx = dx / distance;
    const ny = dy / distance;
    const overlap = minimum - distance;
    const aMass = a.r * a.r;
    const bMass = b.r * b.r;
    const totalMass = aMass + bMass;
    const aCorrection = overlap * (bMass / totalMass);
    const bCorrection = overlap * (aMass / totalMass);
    a.x -= nx * aCorrection;
    a.y -= ny * aCorrection;
    b.x += nx * bCorrection;
    b.y += ny * bCorrection;

    const relativeNormalVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (relativeNormalVelocity >= 0) return;
    const restitution = 0.72;
    const impulse = (-(1 + restitution) * relativeNormalVelocity) / (1 / aMass + 1 / bMass);
    a.vx -= (impulse / aMass) * nx;
    a.vy -= (impulse / aMass) * ny;
    b.vx += (impulse / bMass) * nx;
    b.vy += (impulse / bMass) * ny;
  }

  #clampChip(chip: MutableChip): void {
    chip.x = clamp(finiteOrZero(chip.x), chip.r, this.#width - chip.r);
    chip.y = clamp(finiteOrZero(chip.y), chip.r, this.#height - chip.r);
    chip.targetX = clamp(finiteOrZero(chip.targetX), chip.r, this.#width - chip.r);
    chip.targetY = clamp(finiteOrZero(chip.targetY), chip.r, this.#height - chip.r);
  }

  #bounceOffWalls(chip: MutableChip): void {
    if (chip.x < chip.r) {
      chip.x = chip.r;
      chip.vx = Math.abs(chip.vx) * 0.72;
    } else if (chip.x > this.#width - chip.r) {
      chip.x = this.#width - chip.r;
      chip.vx = -Math.abs(chip.vx) * 0.72;
    }
    if (chip.y < chip.r) {
      chip.y = chip.r;
      chip.vy = Math.abs(chip.vy) * 0.72;
    } else if (chip.y > this.#height - chip.r) {
      chip.y = this.#height - chip.r;
      chip.vy = -Math.abs(chip.vy) * 0.72;
    }
    this.#clampChip(chip);
  }

  #sanitizeChips(): void {
    for (const chip of this.#chips) {
      chip.vx = finiteOrZero(chip.vx);
      chip.vy = finiteOrZero(chip.vy);
      this.#clampChip(chip);
    }
  }

  #maybeSettle(): void {
    if (this.#phase !== "running" || this.#reducedMotion || this.#pointerInfluencesModel()) return;

    let maxSpeed = 0;
    let maxDistance = 0;
    for (const chip of this.#chips) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(chip.vx, chip.vy));
      maxDistance = Math.max(maxDistance, Math.hypot(chip.targetX - chip.x, chip.targetY - chip.y));
    }

    if (maxSpeed <= 4 && maxDistance <= 2) this.#quietMs += this.#fixedStepMs;
    else this.#quietMs = 0;

    if (this.#quietMs < SKILLS_SETTLE_QUIET_MS && this.#simulationMs < SKILLS_SETTLE_DEADLINE_MS) return;

    // Snap only at the lifecycle boundary. This removes sub-pixel asymptotic
    // motion and makes a settled snapshot stable across any later frame rate.
    for (const chip of this.#chips) {
      chip.x = chip.targetX;
      chip.y = chip.targetY;
      chip.vx = 0;
      chip.vy = 0;
    }
    this.#phase = "settled";
    this.#accumulatorMs = 0;
    this.#quietMs = 0;
  }

  #pointerInfluencesModel(): boolean {
    if (!this.#pointer) return false;
    return this.#chips.some(
      (chip) => Math.hypot(chip.x - this.#pointer!.x, chip.y - this.#pointer!.y) < chip.r * 4.2,
    );
  }
}

export function createSkillsSimulation(options: SkillsSimulationOptions): SkillsSimulation {
  return new SkillsSimulation(options);
}

export function serializeSkillsSnapshot(snapshot: SkillsSnapshot): string {
  return JSON.stringify(snapshot);
}

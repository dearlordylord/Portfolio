import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SKILLS_BREAKPOINT,
  SKILLS_FIXED_STEP_MS,
  SKILLS_MAX_CATCH_UP_MS,
  SkillsSimulation,
  type SkillsSnapshot,
} from "../../src/motion/skills-model";

function assertFiniteAndBounded(snapshot: SkillsSnapshot): void {
  expect(Number.isFinite(snapshot.width)).toBe(true);
  expect(Number.isFinite(snapshot.height)).toBe(true);
  expect(Number.isFinite(snapshot.simulationMs)).toBe(true);
  expect(Number.isFinite(snapshot.accumulatorMs)).toBe(true);
  for (const chip of snapshot.chips) {
    for (const value of [chip.r, chip.x, chip.y, chip.vx, chip.vy, chip.targetX, chip.targetY]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(chip.x).toBeGreaterThanOrEqual(chip.r - 1e-8);
    expect(chip.x).toBeLessThanOrEqual(snapshot.width - chip.r + 1e-8);
    expect(chip.y).toBeGreaterThanOrEqual(chip.r - 1e-8);
    expect(chip.y).toBeLessThanOrEqual(snapshot.height - chip.r + 1e-8);
    expect(chip.targetX).toBeGreaterThanOrEqual(chip.r - 1e-8);
    expect(chip.targetX).toBeLessThanOrEqual(snapshot.width - chip.r + 1e-8);
    expect(chip.targetY).toBeGreaterThanOrEqual(chip.r - 1e-8);
    expect(chip.targetY).toBeLessThanOrEqual(snapshot.height - chip.r + 1e-8);
  }
}

function advanceFor(simulation: SkillsSimulation, durationMs: number, sampleMs = SKILLS_FIXED_STEP_MS): void {
  let elapsed = 0;
  while (elapsed < durationMs && simulation.needsFrame) {
    const delta = Math.min(sampleMs, durationMs - elapsed);
    simulation.advance(delta);
    elapsed += delta;
  }
}

describe("SkillsSimulation", () => {
  it("replays the same seeded initialization and elapsed-time sequence", () => {
    const first = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    const second = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    const samples = [7, 13, 16.666, 33.333, 4, 88, 41];

    expect(first.snapshot()).toEqual(second.snapshot());
    for (const sample of samples) {
      first.advance(sample);
      second.advance(sample);
    }
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("uses a bounded catch-up window for a long elapsed gap", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    const result = simulation.advance(10_000);

    expect(result.droppedMs).toBe(10_000 - SKILLS_MAX_CATCH_UP_MS);
    expect(result.simulatedMs).toBeLessThanOrEqual(SKILLS_MAX_CATCH_UP_MS);
    expect(result.steps).toBeLessThanOrEqual(Math.ceil(SKILLS_MAX_CATCH_UP_MS / SKILLS_FIXED_STEP_MS));
    expect(simulation.needsFrame).toBe(true);
  });

  it("walks through entering, running, and settled phases", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    expect(simulation.phase).toBe("entering");
    advanceFor(simulation, 1_300);
    expect(simulation.phase).toBe("running");
    advanceFor(simulation, 15_000);
    expect(simulation.phase).toBe("settled");
  });

  it("is independent of a 60Hz versus 30Hz sampling cadence", () => {
    const sixtyHz = new SkillsSimulation({ width: 1024, height: 520, mobile: false });
    const thirtyHz = new SkillsSimulation({ width: 1024, height: 520, mobile: false });

    advanceFor(sixtyHz, 2000, 1000 / 60);
    advanceFor(thirtyHz, 2000, 1000 / 30);
    expect(sixtyHz.snapshot()).toEqual(thirtyHz.snapshot());
  });

  it("keeps the mobile and desktop chip counts explicit", () => {
    const mobile = new SkillsSimulation({ width: 390, height: 440 });
    const desktop = new SkillsSimulation({ width: 1024, height: 520 });

    expect(mobile.snapshot().mobile).toBe(true);
    expect(mobile.chipCount).toBe(10);
    expect(desktop.snapshot().mobile).toBe(false);
    expect(desktop.chipCount).toBe(15);
  });

  it("can remain idle until an offscreen adapter starts the scene", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, autoStart: false });
    expect(simulation.phase).toBe("idle");
    expect(simulation.needsFrame).toBe(false);
    expect(simulation.chipCount).toBe(0);
    expect(simulation.start().phase).toBe("entering");
    expect(simulation.chipCount).toBe(10);
  });

  it("reinitializes from the same seed when crossing the breakpoint", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    advanceFor(simulation, 800);
    simulation.resize(1024, 520, false);
    const rebuilt = simulation.snapshot();
    const fresh = new SkillsSimulation({ width: 1024, height: 520, mobile: false });

    expect(rebuilt.mobile).toBe(false);
    expect(rebuilt.chips).toHaveLength(15);
    expect(rebuilt.phase).toBe("entering");
    expect(rebuilt.chips).toEqual(fresh.snapshot().chips);
  });

  it("maps an active pointer across a breakpoint resize", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    simulation.setPointer(195, 220);
    simulation.resize(1024, 520, false);
    expect(simulation.snapshot().pointer).toEqual({ x: 512, y: 260 });
  });

  it("maps the current model on same-breakpoint resize", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    advanceFor(simulation, 200);
    const before = simulation.snapshot();
    simulation.resize(480, 550, true);
    const after = simulation.snapshot();

    expect(after.chips).toHaveLength(before.chips.length);
    before.chips.forEach((chip, index) => {
      const resized = after.chips[index];
      expect(resized.x).toBeCloseTo(chip.x * (480 / 390), 8);
      expect(resized.y).toBeCloseTo(chip.y * (550 / 440), 8);
      expect(resized.targetX).toBeCloseTo(chip.targetX * (480 / 390), 8);
      expect(resized.targetY).toBeCloseTo(chip.targetY * (550 / 440), 8);
    });
  });

  it("allows pointer repulsion without compromising finite bounded state", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    const before = simulation.snapshot();
    simulation.setPointer(before.chips[0].x, before.chips[0].y);
    simulation.advance(100);
    assertFiniteAndBounded(simulation.snapshot());
    expect(simulation.snapshot().chips[0].x).not.toBe(before.chips[0].x);
  });

  it("settles and stops requesting frames after the damped lifecycle", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, mobile: true });
    advanceFor(simulation, 15_000);

    expect(simulation.phase).toBe("settled");
    expect(simulation.settled).toBe(true);
    expect(simulation.needsFrame).toBe(false);
    expect(simulation.snapshot().chips.every((chip) => chip.vx === 0 && chip.vy === 0)).toBe(true);

    const settled = simulation.snapshot();
    simulation.advance(1_000);
    expect(simulation.snapshot()).toEqual(settled);
  });

  it("keeps reduced motion settled while preserving all semantic chips", () => {
    const simulation = new SkillsSimulation({ width: 390, height: 440, reducedMotion: true });
    const snapshot = simulation.snapshot();

    expect(snapshot.phase).toBe("settled");
    expect(snapshot.needsFrame).toBe(false);
    expect(snapshot.chips).toHaveLength(10);
    expect(snapshot.chips.every((chip) => chip.vx === 0 && chip.vy === 0)).toBe(true);
    assertFiniteAndBounded(snapshot);
  });

  it("produces a JSON-safe snapshot", () => {
    const simulation = new SkillsSimulation({ width: 1024, height: 520 });
    simulation.setPointer(20, 30);
    const snapshot = simulation.snapshot();
    expect(JSON.parse(simulation.serialize())).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(simulation))).toEqual(snapshot);
  });

  it("preserves finite bounds across generated dimensions and elapsed samples", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 280, max: 1200 }),
        fc.integer({ min: 240, max: 720 }),
        fc.boolean(),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 20 }),
        (width, height, mobile, samples) => {
          const simulation = new SkillsSimulation({ width, height, mobile });
          for (const sample of samples) simulation.advance(sample);
          assertFiniteAndBounded(simulation.snapshot());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps chips representable when an embedded canvas shrinks sharply", () => {
    const simulation = new SkillsSimulation({ width: 1024, height: 520, mobile: false });
    simulation.advance(500);
    simulation.resize(80, 60, false);
    assertFiniteAndBounded(simulation.snapshot());
  });

  it("keeps breakpoint inference aligned with the documented threshold", () => {
    expect(new SkillsSimulation({ width: SKILLS_BREAKPOINT, height: 440 }).mobile).toBe(true);
    expect(new SkillsSimulation({ width: SKILLS_BREAKPOINT + 1, height: 440 }).mobile).toBe(false);
  });
});

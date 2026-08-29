import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  PARTICLE_BREAKPOINT,
  PARTICLE_FIXED_STEP_MS,
  PARTICLE_MAX_CATCH_UP_MS,
  PARTICLE_MAX_NEIGHBOR_CHECKS,
  ParticleSimulation,
  type ParticleSnapshot,
} from "../../src/motion/particle-model";

function advanceFor(simulation: ParticleSimulation, durationMs: number, sampleMs: number): void {
  let elapsed = 0;
  while (elapsed < durationMs) {
    const delta = Math.min(sampleMs, durationMs - elapsed);
    simulation.advance(delta);
    elapsed += delta;
  }
}

function assertFiniteAndBounded(snapshot: ParticleSnapshot): void {
  for (const value of [
    snapshot.width,
    snapshot.height,
    snapshot.simulationMs,
    snapshot.accumulatorMs,
    snapshot.neighborChecks,
    snapshot.totalNeighborChecks,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
  }
  expect(snapshot.neighborChecks).toBeLessThanOrEqual(snapshot.maxNeighborChecks);
  for (const particle of snapshot.particles) {
    for (const value of [
      particle.x,
      particle.y,
      particle.vx,
      particle.vy,
      particle.r,
      particle.alpha,
      particle.ageMs,
      particle.maxAgeMs,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(particle.r).toBeGreaterThan(0);
    expect(particle.x).toBeGreaterThanOrEqual(particle.r - 1e-8);
    expect(particle.x).toBeLessThanOrEqual(snapshot.width - particle.r + 1e-8);
    expect(particle.y).toBeGreaterThanOrEqual(particle.r - 1e-8);
    expect(particle.y).toBeLessThanOrEqual(snapshot.height - particle.r + 1e-8);
  }
}

describe("ParticleSimulation", () => {
  it("replays the same seeded initialization and elapsed-time sequence", () => {
    const first = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    const second = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    const samples = [7, 13, 16.666, 33.333, 4, 88, 41];

    expect(first.snapshot()).toEqual(second.snapshot());
    for (const sample of samples) {
      first.advance(sample);
      second.advance(sample);
    }
    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("is independent of a 60Hz versus 30Hz sampling cadence", () => {
    const sixtyHz = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    const thirtyHz = new ParticleSimulation({ width: 1200, height: 800, mobile: false });

    advanceFor(sixtyHz, 2_000, PARTICLE_FIXED_STEP_MS);
    advanceFor(thirtyHz, 2_000, 1000 / 30);
    expect(sixtyHz.snapshot()).toEqual(thirtyHz.snapshot());
  });

  it("caps catch-up time and fixed work after a long elapsed gap", () => {
    const simulation = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    const result = simulation.advance(10_000);

    expect(result.droppedMs).toBe(10_000 - PARTICLE_MAX_CATCH_UP_MS);
    expect(result.simulatedMs).toBeLessThanOrEqual(PARTICLE_MAX_CATCH_UP_MS);
    expect(result.steps).toBeLessThanOrEqual(15);
    expect(result.snapshot.neighborChecks).toBeLessThanOrEqual(PARTICLE_MAX_NEIGHBOR_CHECKS);
  });

  it("uses an actual bounded grid neighbor pass rather than all-pairs work", () => {
    const simulation = new ParticleSimulation({
      width: 80,
      height: 60,
      mobile: false,
      count: 160,
      maxNeighborChecks: 32,
    });
    const snapshot = simulation.advance(100).snapshot;

    expect(snapshot.count).toBe(160);
    expect(snapshot.actualNeighborChecks).toBeLessThanOrEqual(32);
    expect(snapshot.actualNeighborChecks).toBeLessThan(160 * 159 / 2);
    expect(snapshot.droppedNeighborChecks).toBeGreaterThan(0);
  });

  it("keeps all particle state finite and inside arbitrary canvas bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 1200 }),
        fc.integer({ min: 2, max: 800 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 20 }),
        (width, height, samples) => {
          const simulation = new ParticleSimulation({ width, height, mobile: false, count: 24 });
          for (const sample of samples) simulation.advance(sample);
          assertFiniteAndBounded(simulation.snapshot());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("maps active particles and pointer input on same-mode resize", () => {
    const simulation = new ParticleSimulation({ width: 900, height: 600, mobile: false, count: 12 });
    simulation.setPointer(450, 300);
    advanceFor(simulation, 100, PARTICLE_FIXED_STEP_MS);
    const before = simulation.snapshot();
    simulation.resize(1000, 700, false);
    const after = simulation.snapshot();

    expect(after.pointer).toEqual({ x: 500, y: 350 });
    before.particles.forEach((particle, index) => {
      expect(after.particles[index].x).toBeCloseTo(particle.x * (1000 / 900), 8);
      expect(after.particles[index].y).toBeCloseTo(particle.y * (700 / 600), 8);
    });
  });

  it("disables the field at the documented mobile breakpoint", () => {
    const simulation = new ParticleSimulation({ width: PARTICLE_BREAKPOINT, height: 600 });

    expect(simulation.snapshot()).toMatchObject({
      mobile: true,
      phase: "settled",
      active: false,
      settled: true,
      count: 0,
      reason: "mobile-breakpoint",
    });

    simulation.resize(PARTICLE_BREAKPOINT + 1, 600, false);
    expect(simulation.snapshot()).toMatchObject({ mobile: false, phase: "running", count: 160 });
  });

  it("disables reduced motion while retaining a finite, inspectable snapshot", () => {
    const simulation = new ParticleSimulation({ width: 1200, height: 800, reducedMotion: true });
    expect(simulation.diagnostics()).toMatchObject({
      active: false,
      settled: true,
      reducedMotion: true,
      count: 0,
      reason: "reduced-motion",
    });
    assertFiniteAndBounded(simulation.snapshot());
  });

  it("accepts pointer glow/repulsion as state input without producing invalid values", () => {
    const simulation = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    const before = simulation.snapshot();
    simulation.setPointer(before.particles[0].x, before.particles[0].y);
    const after = simulation.advance(100).snapshot;

    expect(after.pointerGlow).toBe(true);
    expect(after.pointer).not.toBeNull();
    assertFiniteAndBounded(after);
  });

  it("provides a deep JSON-safe snapshot and diagnostics", () => {
    const simulation = new ParticleSimulation({ width: 1200, height: 800, mobile: false });
    simulation.setPointer(20, 30);
    expect(JSON.parse(simulation.serialize())).toEqual(simulation.snapshot());
    expect(JSON.parse(JSON.stringify(simulation))).toEqual(simulation.snapshot());
    expect(JSON.parse(JSON.stringify(simulation.diagnostics()))).toEqual(simulation.diagnostics());
  });
});

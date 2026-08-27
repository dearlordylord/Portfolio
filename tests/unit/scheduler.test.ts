import { describe, expect, it } from "vitest";

import {
  createMotionScheduler,
  type MotionSchedulerDiagnostics,
  type MotionSchedulerScene,
} from "../../src/motion/scheduler";

type PendingFrame = {
  callback: (timestampMs: number) => void;
  cancelled: boolean;
};

class ManualFrameDriver {
  nowMs = 0;
  requestCount = 0;
  cancelCount = 0;
  readonly pending = new Map<number, PendingFrame>();

  request = (callback: (timestampMs: number) => void): number => {
    const handle = ++this.requestCount;
    this.pending.set(handle, { callback, cancelled: false });
    return handle;
  };

  cancel = (handle: number): void => {
    this.cancelCount += 1;
    const frame = this.pending.get(handle);
    if (frame) frame.cancelled = true;
  };

  step(deltaMs = 16): void {
    this.nowMs += deltaMs;
    const frames = [...this.pending.entries()];
    this.pending.clear();
    for (const [, frame] of frames) {
      if (!frame.cancelled) frame.callback(this.nowMs);
    }
  }
}

function createTestScheduler(driver: ManualFrameDriver) {
  return createMotionScheduler({
    requestFrame: driver.request,
    cancelFrame: driver.cancel,
    now: () => driver.nowMs,
  });
}

describe("MotionScheduler", () => {
  it("shares one frame with named scenes and stops when callbacks settle", () => {
    const driver = new ManualFrameDriver();
    const calls: string[] = [];
    const scheduler = createTestScheduler(driver);

    scheduler.register("hero", (timestamp, delta) => {
      calls.push(`hero:${timestamp}:${delta}`);
      return false;
    });
    scheduler.register("skills", (timestamp, delta) => {
      calls.push(`skills:${timestamp}:${delta}`);
      return false;
    });

    expect(driver.requestCount).toBe(1);
    expect(scheduler.diagnostics()).toMatchObject({
      activeScenes: ["hero", "skills"],
      activeSceneNames: ["hero", "skills"],
      pendingFrame: true,
      totalTicks: 0,
      sceneTicks: { hero: 0, skills: 0 },
    });

    driver.step(16);

    expect(calls).toEqual(["hero:16:0", "skills:16:0"]);
    expect(driver.requestCount).toBe(1);
    expect(scheduler.diagnostics()).toMatchObject({
      activeScenes: [],
      activeSceneNames: ["hero", "skills"],
      pendingFrame: false,
      totalTicks: 1,
      sceneTicks: { hero: 1, skills: 1 },
    });
  });

  it("runs a scene again only when it asks for another frame and passes elapsed time", () => {
    const driver = new ManualFrameDriver();
    const deltas: number[] = [];
    let remaining = 2;
    const scheduler = createTestScheduler(driver);

    scheduler.register("timeline", (timestamp, delta) => {
      expect(timestamp).toBe(driver.nowMs);
      deltas.push(delta);
      remaining -= 1;
      return remaining > 0;
    });

    driver.step(10);
    driver.step(25);
    driver.step(40);

    expect(deltas).toEqual([0, 25]);
    expect(scheduler.metrics()).toMatchObject({
      totalTicks: 2,
      sceneTicks: { timeline: 2 },
      pendingFrame: false,
    });
    expect(driver.requestCount).toBe(2);
  });

  it("starts a fresh zero-delta period after all runnable scenes go idle", () => {
    const driver = new ManualFrameDriver();
    const deltas: number[] = [];
    const scheduler = createTestScheduler(driver);
    scheduler.register("hero", (_timestamp, delta) => {
      deltas.push(delta);
      return false;
    });

    driver.step(16);
    expect(deltas).toEqual([0]);

    // A long idle interval is not animation time. The first frame after
    // reactivation must not jump by the interval since the prior RAF.
    driver.nowMs += 2_000;
    scheduler.activate("hero");
    driver.step(16);
    expect(deltas).toEqual([0, 0]);
  });

  it("keeps elapsed continuity while a sibling scene remains runnable", () => {
    const driver = new ManualFrameDriver();
    const heroDeltas: number[] = [];
    const skillDeltas: number[] = [];
    const scheduler = createTestScheduler(driver);
    let heroTicks = 0;
    let skillTicks = 0;
    scheduler.register("hero", (_timestamp, delta) => {
      heroDeltas.push(delta);
      heroTicks += 1;
      return heroTicks < 2;
    });
    scheduler.register("skills", (_timestamp, delta) => {
      skillDeltas.push(delta);
      skillTicks += 1;
      return skillTicks < 3;
    });

    driver.step(16);
    scheduler.activate("hero");
    driver.step(25);

    expect(heroDeltas).toEqual([0, 25]);
    expect(skillDeltas).toEqual([0, 25]);
  });

  it("does not invoke inactive, hidden, or reduced-motion scenes", () => {
    const driver = new ManualFrameDriver();
    const calls: string[] = [];
    const scheduler = createTestScheduler(driver);
    scheduler.register("hero", () => {
      calls.push("hero");
      return true;
    }, { active: false });

    driver.step();
    expect(calls).toEqual([]);
    expect(driver.requestCount).toBe(0);

    scheduler.activate("hero");
    scheduler.setHidden(true);
    driver.step();
    expect(calls).toEqual([]);
    expect(scheduler.diagnostics()).toMatchObject({
      hidden: true,
      reducedMotion: false,
      pendingFrame: false,
      activeSceneNames: ["hero"],
      activeScenes: [],
    });

    scheduler.setHidden(false);
    scheduler.setReducedMotion(true);
    driver.step();
    expect(calls).toEqual([]);
    expect(driver.cancelCount).toBeGreaterThanOrEqual(1);

    scheduler.setReducedMotion(false);
    driver.step();
    expect(calls).toEqual(["hero"]);
  });

  it("cancels pending work when the last scene deactivates and does not duplicate frames", () => {
    const driver = new ManualFrameDriver();
    const scheduler = createTestScheduler(driver);
    scheduler.register("hero", () => true);

    scheduler.activate("hero");
    scheduler.activate("hero");
    expect(driver.requestCount).toBe(1);

    scheduler.deactivate("hero");
    expect(driver.cancelCount).toBe(1);
    expect(driver.pending.size).toBe(1);

    driver.step();
    expect(scheduler.diagnostics()).toMatchObject({
      totalTicks: 0,
      pendingFrame: false,
      activeScenes: [],
    });
  });

  it("honors activation changes made during a tick", () => {
    const driver = new ManualFrameDriver();
    const calls: string[] = [];
    const scheduler = createTestScheduler(driver);
    let registeredThird = false;

    scheduler.register("first", () => {
      calls.push("first");
      scheduler.deactivate("second");
      if (!registeredThird) {
        registeredThird = true;
        scheduler.register("third", () => {
          calls.push("third");
          return false;
        });
      }
      return true;
    });
    scheduler.register("second", () => {
      calls.push("second");
      return true;
    });

    driver.step();
    expect(calls).toEqual(["first"]);
    expect(driver.requestCount).toBe(2);
    expect(scheduler.diagnostics()).toMatchObject({
      activeScenes: ["first", "third"],
      activeSceneNames: ["first", "third"],
      pendingFrame: true,
      sceneTicks: { first: 1, second: 0, third: 0 },
    });

    driver.step();
    expect(calls).toEqual(["first", "first", "third"]);
    expect(scheduler.diagnostics().sceneTicks).toEqual({ first: 2, second: 0, third: 1 });
  });

  it("does not run a removed scene when it is replaced during the same tick", () => {
    const driver = new ManualFrameDriver();
    const calls: string[] = [];
    const scheduler = createTestScheduler(driver);
    let replaced = false;

    scheduler.register("first", () => {
      calls.push("first");
      if (!replaced) {
        replaced = true;
        scheduler.unregister("second");
        scheduler.register("second", () => {
          calls.push("replacement");
          return false;
        });
        return true;
      }
      return false;
    });
    scheduler.register("second", () => {
      calls.push("removed");
      return false;
    });

    driver.step();
    expect(calls).toEqual(["first"]);
    driver.step();
    expect(calls).toEqual(["first", "first", "replacement"]);
  });

  it("produces a JSON-safe snapshot and removes unregistered scenes", () => {
    const driver = new ManualFrameDriver();
    const scheduler = createTestScheduler(driver);
    const handle: MotionSchedulerScene = scheduler.register("hero", () => false);

    driver.step();
    const diagnostics: MotionSchedulerDiagnostics = scheduler.snapshot();
    expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics);
    expect(handle.name).toBe("hero");

    handle.unregister();
    expect(scheduler.diagnostics().sceneTicks).toEqual({});
    expect(scheduler.diagnostics().activeSceneNames).toEqual([]);
  });
});

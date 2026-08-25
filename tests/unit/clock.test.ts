import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../src/motion/clock";

describe("ManualClock", () => {
  it("notifies subscribers in stable insertion order", () => {
    const clock = new ManualClock(10);
    const calls: string[] = [];
    clock.subscribe((now, delta) => calls.push(`a:${now}:${delta}`));
    clock.subscribe((now, delta) => calls.push(`b:${now}:${delta}`));

    clock.step(5);

    expect(calls).toEqual(["a:15:5", "b:15:5"]);
  });

  it("lands exactly on the requested duration for generated sampling intervals", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (durationMs, sampleEveryMs) => {
          const clock = new ManualClock();
          clock.runFor(durationMs, sampleEveryMs);
          expect(clock.nowMs).toBe(durationMs);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects backwards time", () => {
    const clock = new ManualClock(100);
    expect(() => clock.seek(99)).toThrow(/only seek forward/);
  });
});


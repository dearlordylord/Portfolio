import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createSeededRandom } from "../../src/motion/random";

describe("createSeededRandom", () => {
  it("replays the same sequence from the same seed", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 100 }), (seed, count) => {
        const first = createSeededRandom(seed);
        const second = createSeededRandom(seed);
        expect(Array.from({ length: count }, first)).toEqual(Array.from({ length: count }, second));
      }),
      { numRuns: 200 },
    );
  });

  it("always produces values in [0, 1)", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const random = createSeededRandom(seed);
        for (let index = 0; index < 100; index += 1) {
          const value = random();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});


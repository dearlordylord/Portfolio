import { describe, expect, it } from "vitest";

import { nextExactSequenceFrame } from "../../src/motion/sequence-playback";

describe("sequence playback exact-frame gate", () => {
  it("waits instead of advancing through an unloaded frame", () => {
    expect(nextExactSequenceFrame(0, 4, new Set([0, 2, 3, 4]), 150, false)).toBe(null);
    expect(nextExactSequenceFrame(0, 4, new Set([0, 1, 2, 3, 4]), 150, false)).toBe(1);
  });

  it("advances only one contiguous exact frame at a time", () => {
    const loaded = new Set([10, 11, 12, 13]);
    expect(nextExactSequenceFrame(10, 13, loaded, 150, false)).toBe(11);
    expect(nextExactSequenceFrame(11, 13, loaded, 150, false)).toBe(12);
    expect(nextExactSequenceFrame(12, 13, loaded, 150, false)).toBe(13);
  });

  it("permits a loop wrap only when frame zero is exact", () => {
    expect(nextExactSequenceFrame(149, 0, new Set([149]), 150, true)).toBe(null);
    expect(nextExactSequenceFrame(149, 0, new Set([0, 149]), 150, true)).toBe(0);
  });
});

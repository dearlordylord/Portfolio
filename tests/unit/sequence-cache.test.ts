import { describe, expect, it } from "vitest";

import {
  BoundedFrameCache,
  SequenceFrameCoordinator,
  UniqueFrameTransferAccounting,
  prefetchFrames,
} from "../../src/motion/sequence-cache";

describe("bounded decoded-frame cache", () => {
  it("evicts least-recently-used frames and disposes resources", () => {
    const disposed: Array<[string, number]> = [];
    const cache = new BoundedFrameCache<string>(2, (value, frame) => disposed.push([value, frame]));

    cache.set(0, "zero");
    cache.set(1, "one");
    expect(cache.get(0)).toBe("zero");
    cache.set(2, "two");

    expect(cache.snapshot()).toMatchObject({
      capacity: 2,
      size: 2,
      frames: [0, 2],
      hits: 1,
      evictions: 1,
    });
    expect(disposed).toEqual([["one", 1]]);
  });

  it("keeps replacement and clear disposal explicit", () => {
    const disposed: Array<[string, number]> = [];
    const cache = new BoundedFrameCache<string>(2, (value, frame) => disposed.push([value, frame]));
    cache.set(4, "old");
    cache.set(4, "new");
    cache.delete(4);
    cache.set(8, "eight");
    cache.clear();
    expect(disposed).toEqual([["old", 4], ["new", 4], ["eight", 8]]);
  });

  it("allows an evicted frame to be decoded again without exceeding capacity", () => {
    const disposed: Array<[string, number]> = [];
    const cache = new BoundedFrameCache<string>(2, (value, frame) => disposed.push([value, frame]));
    cache.set(0, "first");
    cache.set(1, "second");
    cache.set(2, "third");

    // The renderer can reload frame 0 after its decoded resource is disposed.
    cache.set(0, "first-reloaded");
    expect(cache.snapshot()).toMatchObject({ capacity: 2, size: 2, frames: [2, 0], evictions: 2 });
    expect(disposed).toEqual([["first", 0], ["second", 1]]);
    expect(cache.get(0)).toBe("first-reloaded");
  });
});

describe("unique sequence transfer accounting", () => {
  it("estimates bytes from unique successful frame IDs, independently of cache occupancy", () => {
    const accounting = new UniqueFrameTransferAccounting(4, 1_000);
    expect(accounting.record(0)).toBe(true);
    expect(accounting.record(0)).toBe(false);
    expect(accounting.record(3)).toBe(true);
    expect(accounting.snapshot()).toEqual({
      frameCount: 4,
      totalBytes: 1_000,
      loadedFrameCount: 2,
      estimatedBytes: 500,
      loadedFrames: [0, 3],
    });
  });
});

describe("target → displayed → rendered coordinator", () => {
  it("rejects stale async completion without moving displayed/rendered backward", () => {
    const coordinator = new SequenceFrameCoordinator(150);
    const oldTarget = coordinator.request(62);
    expect(coordinator.display(oldTarget).accepted).toBe(true);
    expect(coordinator.render(oldTarget).accepted).toBe(true);

    const latestTarget = coordinator.request(38);
    expect(coordinator.display(oldTarget)).toEqual({ accepted: false, reason: "stale-generation" });
    expect(coordinator.render(oldTarget)).toEqual({ accepted: false, reason: "stale-generation" });
    expect(coordinator.snapshot()).toMatchObject({
      targetFrame: 38,
      displayedFrame: 62,
      renderedFrame: 62,
      generation: 2,
      staleCommitCount: 2,
    });

    expect(coordinator.display(latestTarget).accepted).toBe(true);
    expect(coordinator.render(latestTarget).accepted).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ displayedFrame: 38, renderedFrame: 38 });
  });

  it("does not render a frame before that target is displayed", () => {
    const coordinator = new SequenceFrameCoordinator(150);
    const target = coordinator.request(7);
    expect(coordinator.render(target)).toEqual({ accepted: false, reason: "not-displayed" });
    expect(coordinator.snapshot()).toMatchObject({
      targetFrame: 7,
      displayedFrame: null,
      renderedFrame: null,
      staleCommitCount: 1,
    });
  });

  it("allows an intentional backward seek with a fresh generation", () => {
    const coordinator = new SequenceFrameCoordinator(150);
    const forward = coordinator.request(90);
    coordinator.display(forward);
    coordinator.render(forward);
    const backward = coordinator.request(31);
    expect(coordinator.display(backward).accepted).toBe(true);
    expect(coordinator.render(backward).accepted).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ targetFrame: 31, displayedFrame: 31, renderedFrame: 31 });
  });
});

describe("sequence prefetch window", () => {
  it("clamps a deterministic neighborhood at sequence edges", () => {
    expect(prefetchFrames(0, 5, 2)).toEqual([0, 1, 2]);
    expect(prefetchFrames(2, 5, 1)).toEqual([1, 2, 3]);
    expect(prefetchFrames(4, 5, 2)).toEqual([2, 3, 4]);
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AssetReadinessRegistry,
  createAssetReadinessRegistry,
  selectNearestReadyFrame,
  type AssetExpectation,
} from "../../src/motion/asset-fallback";

function heroExpectations(): AssetExpectation[] {
  return [
    { key: "frame-000", frame: 0, phase: "intro" },
    { key: "frame-001", frame: 1, phase: "intro" },
    { key: "frame-002", frame: 2, phase: "intro" },
    { key: "frame-032", frame: 32, phase: "later" },
    { key: "frame-149", frame: 149, phase: "later" },
  ];
}

function exactIntroExpectations(): AssetExpectation[] {
  return Array.from({ length: 32 }, (_, frame) => ({
    key: `frame-${String(frame).padStart(3, "0")}`,
    frame,
    phase: "intro" as const,
  }));
}

describe("asset readiness and frame fallback", () => {
  it("keeps intro readiness separate from later-frame loading", () => {
    const registry = createAssetReadinessRegistry(heroExpectations(), {
      intro: { minReady: 2 },
    });

    expect(registry.snapshot()).toMatchObject({
      state: "pending",
      degraded: false,
      expected: 5,
      expectedKeys: ["frame-000", "frame-001", "frame-002", "frame-032", "frame-149"],
      ready: 0,
      pending: 5,
      failed: 0,
      introReady: false,
      allReady: false,
      intro: { expected: 3, required: 2, ready: 0, pending: 3, failed: 0 },
    });

    registry.markReady("frame-000");
    expect(registry.introReady).toBe(false);
    registry.markReady("frame-002");
    expect(registry.introReady).toBe(true);
    expect(registry.state).toBe("ready");
    expect(registry.allReady).toBe(false);

    registry.markReady("frame-032");
    registry.markReady("frame-149");
    expect(registry.allReady).toBe(false);
    registry.markReady("frame-001");
    expect(registry.allReady).toBe(true);
    expect(registry.state).toBe("ready");
  });

  it("allows a named missing intro frame to start in an explicit degraded state", () => {
    const registry = new AssetReadinessRegistry(heroExpectations(), {
      intro: { minReady: 2, allowFailed: true },
    });
    registry.markReady("frame-000");
    registry.markFailed("frame-001", { code: "missing-file", message: "fixture omitted" });
    registry.markReady("frame-002");

    const diagnostics = registry.diagnostics();
    expect(diagnostics.introReady).toBe(true);
    expect(diagnostics.state).toBe("degraded");
    expect(diagnostics.failedAssets).toEqual([
      {
        key: "frame-001",
        frame: 1,
        phase: "intro",
        code: "missing-file",
        message: "fixture omitted",
      },
    ]);
    expect(diagnostics.pendingKeys).toContain("frame-032");
  });

  it("counts settled failures toward a full 32-frame intro threshold", () => {
    const oneMissing = createAssetReadinessRegistry(exactIntroExpectations(), {
      intro: { minReady: 32, allowFailed: true },
    });
    for (let frame = 0; frame < 31; frame += 1) {
      oneMissing.markReady(`frame-${String(frame).padStart(3, "0")}`);
    }
    oneMissing.markFailed("frame-031", "missing-file");

    expect(oneMissing.introReady).toBe(true);
    expect(oneMissing.diagnostics()).toMatchObject({
      state: "degraded",
      intro: { expected: 32, required: 32, ready: 31, failed: 1, pending: 0, allowFailed: true },
      failedAssets: [{ key: "frame-031", frame: 31, code: "missing-file" }],
    });

    const allMissing = createAssetReadinessRegistry(exactIntroExpectations(), {
      intro: { minReady: 32, allowFailed: true },
    });
    for (let frame = 0; frame < 32; frame += 1) {
      allMissing.markFailed(`frame-${String(frame).padStart(3, "0")}`, "offline");
    }
    expect(allMissing.introReady).toBe(true);
    expect(allMissing.diagnostics()).toMatchObject({
      state: "degraded",
      intro: { expected: 32, required: 32, ready: 0, failed: 32, pending: 0 },
    });
  });

  it("marks an unmet intro threshold degraded once every attempt has settled", () => {
    const registry = createAssetReadinessRegistry(heroExpectations(), {
      intro: { minReady: 3 },
    });
    registry.markReady("frame-000");
    registry.markReady("frame-002");
    expect(registry.state).toBe("pending");

    registry.markFailed("frame-001", "decode-error");
    expect(registry.introReady).toBe(false);
    expect(registry.state).toBe("degraded");
    expect(registry.diagnostics().failedAssets[0]).toMatchObject({
      key: "frame-001",
      code: "decode-error",
    });
  });

  it("keeps a later-frame failure explicit while intro remains playable", () => {
    const registry = createAssetReadinessRegistry(heroExpectations());
    for (const key of ["frame-000", "frame-001", "frame-002"]) registry.markReady(key);
    expect(registry.state).toBe("ready");

    registry.markFailed("frame-149", { code: "network", message: "offline" });
    expect(registry.introReady).toBe(true);
    expect(registry.state).toBe("degraded");
    expect(registry.allReady).toBe(false);
  });

  it.each([
    { requested: 0, candidates: [0, 4, 8], frame: 0, reason: "exact" },
    { requested: 3, candidates: [0, 4, 8], frame: 4, reason: "nearest-ready" },
    { requested: 5, candidates: [0, 4, 8], frame: 4, reason: "nearest-ready" },
    { requested: 6, candidates: [4, 8], frame: 4, reason: "nearest-ready" },
    { requested: 6, candidates: [8], frame: 8, reason: "nearest-ready" },
  ] as const)("selects a deterministic nearest ready frame %#", (table) => {
    const selection = selectNearestReadyFrame(
      table.requested,
      table.candidates.map((frame) => ({ frame, key: `frame-${frame}` })),
    );
    expect(selection).toMatchObject({
      requestedFrame: table.requested,
      renderedFrame: table.frame,
      reason: table.reason,
      usedFallback: table.reason !== "exact",
    });
  });

  it("uses lower frames for ties and key order for duplicate frame aliases", () => {
    expect(
      selectNearestReadyFrame(5, [
        { frame: 8, key: "later" },
        { frame: 2, key: "lower" },
      ]),
    ).toMatchObject({ renderedFrame: 2, key: "lower" });
    expect(
      selectNearestReadyFrame(5, [
        { frame: 5, key: "z-alias" },
        { frame: 5, key: "a-alias" },
      ]),
    ).toMatchObject({ renderedFrame: 5, key: "a-alias", reason: "exact" });
  });

  it("reports missing or late requested frames without returning a blank silently", () => {
    const registry = createAssetReadinessRegistry(heroExpectations(), {
      intro: { minReady: 1 },
    });
    registry.markReady("frame-000");
    const early = registry.selectNearestReadyFrame(32);
    expect(early).toMatchObject({ renderedFrame: 0, usedFallback: true, reason: "nearest-ready" });
    expect(registry.diagnostics().fallbackCount).toBe(1);

    registry.markReady("frame-032");
    expect(registry.selectNearestReadyFrame(32)).toMatchObject({
      renderedFrame: 32,
      usedFallback: false,
      reason: "exact",
    });
    expect(registry.diagnostics().fallbackCount).toBe(1);

    registry.markFailed("frame-032", "decode-error");
    expect(registry.selectNearestReadyFrame(32)).toMatchObject({ renderedFrame: 0, usedFallback: true });
  });

  it("returns an explicit no-ready-frame result while assets are still pending", () => {
    const registry = createAssetReadinessRegistry(heroExpectations(), { intro: { minReady: 1 } });
    expect(registry.selectFrame(90)).toEqual({
      requestedFrame: 90,
      renderedFrame: null,
      key: null,
      usedFallback: true,
      reason: "no-ready-frame",
    });
    expect(registry.state).toBe("pending");
  });

  it("can restrict a ready selection to resources resident in a bounded decode cache", () => {
    const registry = createAssetReadinessRegistry(heroExpectations(), { intro: { minReady: 1 } });
    for (const key of ["frame-000", "frame-001", "frame-002", "frame-032"]) registry.markReady(key);

    expect(registry.selectFrame(32, new Set(["frame-000", "frame-001"]))).toMatchObject({
      renderedFrame: 1,
      key: "frame-001",
      reason: "nearest-ready",
    });
    expect(registry.selectFrame(32, new Set(["frame-032"]))).toMatchObject({
      renderedFrame: 32,
      key: "frame-032",
      reason: "exact",
    });
    expect(registry.selectFrame(32, new Set())).toMatchObject({
      renderedFrame: null,
      reason: "no-ready-frame",
    });
  });

  it("produces JSON-safe diagnostics with stable status counts", () => {
    const registry = createAssetReadinessRegistry([
      { key: "icon-a", phase: "optional" },
      { key: "icon-b", phase: "optional" },
    ]);
    registry.markReady("icon-a");
    registry.markFailed("icon-b", "missing-icon");
    const snapshot = registry.snapshot();
    const roundTrip = JSON.parse(JSON.stringify(snapshot));
    expect(roundTrip).toEqual(snapshot);
    expect(roundTrip).toMatchObject({
      expected: 2,
      ready: 1,
      pending: 0,
      failed: 1,
      state: "degraded",
      failedAssets: [{ key: "icon-b", code: "missing-icon" }],
    });
  });

  it("accepts string-only expectations for icon manifests", () => {
    const registry = createAssetReadinessRegistry(["figma", "missing-icon"]);
    registry.markReady("figma");
    registry.markFailed("missing-icon", "not-found");
    expect(registry.snapshot()).toMatchObject({
      expectedKeys: ["figma", "missing-icon"],
      readyKeys: ["figma"],
      failedAssets: [{ key: "missing-icon", frame: null, phase: "optional", code: "not-found" }],
      state: "degraded",
    });
  });

  it("does not depend on expectation insertion order for nearest-frame selection", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 149 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 149 }), { minLength: 1, maxLength: 30 }),
        (requested, frames) => {
          const shuffled = [...frames].reverse();
          const first = selectNearestReadyFrame(
            requested,
            frames.map((frame) => ({ frame, key: `f-${frame}` })),
          );
          const second = selectNearestReadyFrame(
            requested,
            shuffled.map((frame) => ({ frame, key: `f-${frame}` })),
          );
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });
});

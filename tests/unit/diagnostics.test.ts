import {
  setupMotionDiagnostics,
  type MotionDiagnosticsPort,
} from "../../src/browser/diagnostics";
import { describe, expect, it } from "vitest";

function fakeWindow(hostname: string, search: string): Window {
  const document = {
    getElementById: () => null,
    getAnimations: () => [],
  } as unknown as Document;

  return {
    location: { hostname, search },
    document,
    performance: { now: () => 123.5 },
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 2,
    scrollX: 12,
    scrollY: 34,
    visualViewport: null,
  } as unknown as Window;
}

function exposedPort(ownerWindow: Window): MotionDiagnosticsPort | undefined {
  return (ownerWindow as Window & { __portfolioMotion?: MotionDiagnosticsPort }).__portfolioMotion;
}

describe("setupMotionDiagnostics", () => {
  it("does not expose diagnostics unless both loopback and query gates pass", () => {
    const remote = fakeWindow("portfolio.example", "?motionDiagnostics=1");
    expect(setupMotionDiagnostics({ window: remote })).toBeUndefined();
    expect(exposedPort(remote)).toBeUndefined();

    const loopback = fakeWindow("127.0.0.1", "");
    expect(setupMotionDiagnostics({ window: loopback })).toBeUndefined();
    expect(exposedPort(loopback)).toBeUndefined();
  });

  it("registers scene readers, applies disable flags, and snapshots stable browser state", () => {
    const ownerWindow = fakeWindow("localhost", "?motionDiagnostics=1&motionDisable=particles%2Ccontact");
    const diagnostics = setupMotionDiagnostics({ window: ownerWindow });

    expect(diagnostics).toBeDefined();
    diagnostics!.register("hero", () => ({ phase: "ready" }));
    diagnostics!.register("throws", () => {
      throw new Error("reader failed");
    });

    expect(diagnostics!.isDisabled("particles")).toBe(true);
    expect(diagnostics!.isDisabled("hero")).toBe(false);
    expect(exposedPort(ownerWindow)).toBe(diagnostics);
    expect(diagnostics!.snapshot()).toMatchObject({
      version: 1,
      capturedAt: 123.5,
      viewport: { innerWidth: 390, innerHeight: 844, dpr: 2, visual: null },
      scroll: { x: 12, y: 34 },
      elements: {},
      animations: [],
      scenes: {
        hero: { phase: "ready" },
        throws: { error: "Error: reader failed" },
      },
    });
  });

  it("keeps scene-isolation flags independently addressable", () => {
    const ownerWindow = fakeWindow(
      "localhost",
      "?motionDiagnostics=1&motionDisable=skills%2Ctimeline%2Ccontact",
    );
    const diagnostics = setupMotionDiagnostics({ window: ownerWindow });

    expect(diagnostics?.isDisabled("skills")).toBe(true);
    expect(diagnostics?.isDisabled("timeline")).toBe(true);
    expect(diagnostics?.isDisabled("contact")).toBe(true);
    expect(diagnostics?.isDisabled("particles")).toBe(false);
  });

  it("allows an explicit dev-only non-loopback inspection host", () => {
    const ownerWindow = fakeWindow("phone-preview.example", "?motionDiagnostics=1");
    expect(setupMotionDiagnostics({ window: ownerWindow, allowNonLoopback: true })).toBeDefined();
  });
});

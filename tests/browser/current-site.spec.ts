import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type DiagnosticsSnapshot = {
  viewport: { innerWidth: number; innerHeight: number; dpr: number };
  elements: Record<
    string,
    { rect: { x: number; y: number; width: number; height: number; top: number; bottom: number }; style: Record<string, string> } | null
  >;
  scenes: {
    hero: {
      phase: string;
      active: boolean;
      autoplay: boolean;
      reducedMotion: boolean;
      exitHoldPending: boolean;
      readinessWatchdogPending: boolean;
      playbackCompleted: boolean;
      displayFrame: number;
      targetFrame: number;
      assets: {
        requested: number;
        activeRequests: number;
        introRequestCountAtReady: number | null;
        laterQueueStarted: boolean;
        introReady: boolean;
        allReady: boolean;
        loaded: number;
        pending: number;
        expected: number;
        degraded: boolean;
        fallbackCount: number;
        failedAssets: Array<{ key: string; frame: number | null; phase: string; code: string }>;
        lastFrameSelection: {
          requestedFrame: number;
          renderedFrame: number | null;
          key: string | null;
          usedFallback: boolean;
          reason: string;
        } | null;
      };
      geometry: { stableHeight: number; boundary: number; stageTop: number };
      overlays: {
        roleOpacity: number;
        experienceOpacity: number;
        ctaAvailable: boolean;
        ctaOpacity: number;
        ctaPointerEvents: string;
      };
      canvas: {
        cssWidth: number;
        cssHeight: number;
        backingWidth: number;
        backingHeight: number;
        renderedAsset: {
          key: string;
          source: string;
          destination: { x: number; y: number; width: number; height: number };
          naturalWidth: number;
          naturalHeight: number;
        } | null;
      };
    };
    particles: {
      active: boolean;
      count: number;
      pairChecksPerFrame: number;
      cssWidth: number;
      cssHeight: number;
      dpr: number;
      backingWidth: number;
      backingHeight: number;
      reducedMotion?: boolean;
      mobileDisabled?: boolean;
    };
    contact?: { active: boolean; reducedMotion?: boolean; reason?: string };
    timeline?: {
      active: boolean;
      disabled?: boolean;
      reason?: string;
      reducedMotion: boolean;
      updateCount: number;
      rowsVisible: number;
      fillHeight: string;
      cursorTop: string;
    };
    skills: {
      started: boolean;
      phase: string;
      active: boolean;
      reducedMotion: boolean;
      mobileModel?: boolean | null;
      seed: number;
      width: number;
      height: number;
      disabled?: boolean;
      reason?: string;
      needsFrame?: boolean;
      iconAssetsLoaded: number;
      iconAssetsPending: string[];
      iconAssetsFailed: string[];
      assetReadiness: {
        state: string;
        degraded: boolean;
        fallbackCount: number;
        failedAssets: Array<{ key: string; code: string }>;
      };
      chips: Array<{ label: string; x: number; y: number; r: number }>;
    };
    scheduler: {
      activeScenes: string[];
      activeSceneNames: string[];
      registeredActiveScenes: string[];
      pendingFrame: boolean;
      pendingFrameId: number | null;
      totalTicks: number;
      sceneTicks: Record<string, number>;
      hidden: boolean;
      reducedMotion: boolean;
      lastTimestampMs: number | null;
      lastDeltaMs: number;
      lastFrameDeltaMs: number;
      disposed: boolean;
    };
  };
};

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const diagnostics = (window as typeof window & {
      __portfolioMotion?: { snapshot(): DiagnosticsSnapshot };
    }).__portfolioMotion;
    if (!diagnostics) throw new Error("Motion diagnostics are not enabled");
    return diagnostics.snapshot();
  });
}

async function canvasHasPaint(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return true;
    }
    return false;
  });
}

async function prepareLocalPage(page: Page): Promise<void> {
  // Keep the baseline independent of external Google Fonts availability.
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
}

async function installPausedClock(page: Page): Promise<void> {
  await page.clock.install({ time: 0 });
  // Pausing at the installation timestamp races the real milliseconds between
  // the two protocol calls. No application is loaded yet, so advancing to a
  // fixed safe epoch pauses deterministically without advancing app work.
  await page.clock.pauseAt(60_000);
}

function writeBaseline(projectName: string, name: string, body: Buffer | string): void {
  if (process.env.WRITE_MOTION_BASELINE !== "1") return;
  const directory = path.resolve(
    "motion-artifacts",
    process.env.MOTION_BASELINE_KIND ?? "baseline-current",
    "browser",
    projectName,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), body);
}

test("normal page does not expose test diagnostics", async ({ page }) => {
  await prepareLocalPage(page);
  // This test checks API exposure only; avoid spending CPU on unrelated live loops.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(
    await page.evaluate(
      () => "__portfolioMotion" in window || "__portfolioMotionScheduler" in window,
    ),
  ).toBe(false);
});

test("case overlay opens from data wiring and closes through native controls", async ({ page }) => {
  await prepareLocalPage(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const card = page.locator('.case-card[data-case-id="fridj"]');
  await expect(card).toHaveAttribute("data-case-id", "fridj");
  expect(await card.getAttribute("onclick")).toBeNull();
  expect(await page.locator("#case-overlay").getAttribute("onclick")).toBeNull();

  await card.click();
  await expect(page.locator("#case-overlay")).toHaveClass(/open/);
  await expect(page.locator("#case-title")).toHaveText("Fridgie");
  await expect(page.locator("#case-subtitle")).toHaveText("Smart food tracker & recipe generator");
  await expect(page.locator("#case-overlay-tags span")).toHaveCount(3);
  await expect(page.locator("#case-images img")).toHaveCount(16);
  await expect
    .poll(async () => page.locator("#case-images img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)))
    .toBe(true);
  expect(
    await page.locator("#case-images img").evaluateAll((images) =>
      images.filter((image) => (image as HTMLImageElement).naturalWidth === 0).map((image) => (image as HTMLImageElement).src),
    ),
  ).toEqual([]);

  // Mobile Chromium can keep a fixed/backdrop-filter control in a transient
  // compositor-stability state while the lazy case images are inserted. Force
  // only the pointer dispatch; the native close listener and resulting state
  // assertion remain unchanged.
  await page.locator("#case-close").click({ force: true });
  await expect(page.locator("#case-overlay")).not.toHaveClass(/open/);

  await card.click();
  await page.locator("#case-overlay").evaluate((overlay) => {
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.locator("#case-overlay")).not.toHaveClass(/open/);
});

test("case dialog exposes its labelled semantics and traps Tab focus", async ({ page }) => {
  await prepareLocalPage(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const card = page.locator('.case-card[data-case-id="fridj"]');
  await card.click();

  const overlay = page.locator("#case-overlay");
  await expect(overlay).toHaveAttribute("role", "dialog");
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  await expect(overlay).toHaveAttribute("aria-labelledby", "case-title");
  await expect(overlay).toHaveAttribute("aria-describedby", "case-subtitle");
  await expect(page.locator("#case-title")).toHaveAttribute("id", "case-title");
  await expect(page.locator("#case-subtitle")).toHaveAttribute("id", "case-subtitle");
  await expect(page.locator("#case-close")).toHaveAttribute("aria-label", "Close case study");

  // The real manifest currently has one focusable control. Add a second
  // focusable probe so both ends of the generic trap are exercised by trusted
  // Playwright keyboard input.
  await page.locator("#case-overlay-inner").evaluate((inner) => {
    const probe = document.createElement("a");
    probe.id = "case-focus-probe";
    probe.href = "#case-images";
    probe.textContent = "Focus probe";
    inner.append(probe);
  });

  const close = page.locator("#case-close");
  const probe = page.locator("#case-focus-probe");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(probe).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(probe).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
});

test("hero ready state is deterministic and inspectable", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);

  await page.clock.runFor(1600);
  const current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("ready");
  expect(current.scenes.hero.assets.loaded).toBeGreaterThanOrEqual(32);
  expect(current.scenes.hero.assets.fallbackCount).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(current.scenes.hero.assets.failedAssets)).toBe(true);
  if (current.scenes.hero.assets.degraded) {
    expect(current.scenes.hero.assets.failedAssets.length).toBeGreaterThan(0);
  }
  if (current.scenes.hero.assets.lastFrameSelection) {
    const selection = current.scenes.hero.assets.lastFrameSelection;
    expect(selection.requestedFrame).toBeGreaterThanOrEqual(0);
    expect(selection.usedFallback).toBe(selection.reason !== "exact");
  }
  expect(current.scenes.particles).toMatchObject({ active: false, count: 0, pairChecksPerFrame: 0 });
  expect(current.scenes.scheduler.activeScenes).not.toContain("particles");
  const expectedDpr = Math.min(current.viewport.dpr, 2);
  expect(current.scenes.hero.canvas.backingWidth).toBe(
    Math.round(current.scenes.hero.canvas.cssWidth * expectedDpr),
  );
  expect(current.scenes.hero.canvas.backingHeight).toBe(
    Math.round(current.scenes.hero.canvas.cssHeight * expectedDpr),
  );
  expect(pageErrors).toEqual([]);

  const stateJson = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
  const screenshot = await page.screenshot({ animations: "allow" });
  await testInfo.attach("motion-state.json", {
    body: stateJson,
    contentType: "application/json",
  });
  await testInfo.attach("hero-ready.png", {
    body: screenshot,
    contentType: "image/png",
  });
  writeBaseline(testInfo.project.name, "hero-ready-state.json", stateJson);
  writeBaseline(testInfo.project.name, "hero-ready.png", screenshot);
});

test("mobile hero fails open when Safari-like image decode stalls", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Safari-like decode fallback is covered by the mobile project");
  test.slow();
  await prepareLocalPage(page);
  // Safari can expose decode() while leaving its promise pending for a
  // resource that onload has already delivered. Model that browser boundary
  // without replacing native image loading or the production scheduler.
  await page.addInitScript(() => {
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: () => new Promise<void>(() => {}),
    });
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });

  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.phase, { timeout: 20_000 })
    .not.toBe("loading");
  await page.clock.runFor(1_600);

  const readGeometry = async () => {
    const state = await snapshot(page);
    const canvas = state.scenes.hero.canvas;
    const asset = canvas.renderedAsset;
    expect(asset, "a loaded frame must be rendered after the ready handoff").not.toBeNull();
    if (!asset) throw new Error("rendered asset missing");
    return {
      state,
      scale: asset.destination.height / asset.naturalHeight,
      xOffset: asset.destination.x - canvas.cssWidth / 2,
      y: asset.destination.y,
    };
  };

  const current = await readGeometry();
  expect(current.state.scenes.hero.assets.introReady).toBe(true);
  await expect(page.locator("#scrolly-loader")).toHaveClass(/hidden/);
  expect(await canvasHasPaint(page, "#scrolly-canvas")).toBe(true);

  // A Safari-like delayed decoder must not alter the CSS-pixel destination or
  // the DPR-scaled backing store when the visual viewport settles/reflows.
  const expectedDpr = Math.min(current.state.viewport.dpr, 2);
  for (const viewport of [
    { width: 360, height: 700 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const state = await snapshot(page);
        const canvas = state.scenes.hero.canvas;
        const expectedDpr = Math.min(state.viewport.dpr, 2);
        return (
          canvas.cssWidth === viewport.width &&
          canvas.backingWidth === Math.round(canvas.cssWidth * expectedDpr) &&
          canvas.backingHeight === Math.round(canvas.cssHeight * expectedDpr)
        );
      }, { timeout: 5_000 })
      .toBe(true);
    await page.clock.runFor(16);
    const settled = await readGeometry();
    const hero = settled.state.scenes.hero;
    expect(hero.phase).not.toBe("loading");
    expect(hero.canvas.cssHeight).toBeCloseTo(current.state.scenes.hero.canvas.cssHeight, 1);
    expect(hero.canvas.backingWidth).toBe(Math.round(hero.canvas.cssWidth * expectedDpr));
    expect(hero.canvas.backingHeight).toBe(Math.round(hero.canvas.cssHeight * expectedDpr));
    expect(settled.scale).toBeCloseTo(current.scale, 6);
    expect(settled.xOffset).toBeCloseTo(current.xOffset, 6);
    expect(settled.y).toBeCloseTo(current.y, 6);
  }
});

test("mobile hero converges after a transient short viewport", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Viewport-settle coverage belongs to mobile projects");
  test.slow();
  await prepareLocalPage(page);
  await installPausedClock(page);
  // Model Mobile Safari's first layout pass while browser chrome is expanded.
  // The later resize is the settled visual/layout viewport that must become
  // the stable first-screen height for the remainder of this orientation.
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1_600);
  const short = await snapshot(page);
  expect(short.scenes.hero.geometry.stableHeight).toBe(400);
  expect(short.scenes.hero.canvas.renderedAsset).not.toBeNull();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.geometry.stableHeight, { timeout: 5_000 })
    .toBe(844);
  await page.clock.runFor(16);
  const settled = await snapshot(page);
  const settledAsset = settled.scenes.hero.canvas.renderedAsset;
  expect(settledAsset).not.toBeNull();
  expect(settled.scenes.hero.canvas.cssHeight).toBeGreaterThan(short.scenes.hero.canvas.cssHeight);
  expect(settledAsset!.destination.height).toBeGreaterThan(short.scenes.hero.canvas.renderedAsset!.destination.height);
  expect(settled.scenes.hero.canvas.backingWidth).toBe(
    Math.round(settled.scenes.hero.canvas.cssWidth * Math.min(settled.viewport.dpr, 2)),
  );
  expect(settled.scenes.hero.canvas.backingHeight).toBe(
    Math.round(settled.scenes.hero.canvas.cssHeight * Math.min(settled.viewport.dpr, 2)),
  );

  // A second initialization at the settled viewport must produce the same
  // CSS-pixel destination and effective-DPR transform, not a quarter-sized
  // first frame caused by an early backing-store race.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1_600);
  const reloaded = await snapshot(page);
  const reloadedAsset = reloaded.scenes.hero.canvas.renderedAsset;
  expect(reloadedAsset).not.toBeNull();
  expect(reloaded.scenes.hero.geometry.stableHeight).toBe(844);
  expect(reloaded.scenes.hero.canvas.cssHeight).toBeCloseTo(settled.scenes.hero.canvas.cssHeight, 5);
  expect(reloadedAsset!.destination.width / reloadedAsset!.naturalWidth).toBeCloseTo(
    settledAsset!.destination.width / settledAsset!.naturalWidth,
    6,
  );
  expect(reloadedAsset!.destination.height / reloadedAsset!.naturalHeight).toBeCloseTo(
    settledAsset!.destination.height / settledAsset!.naturalHeight,
    6,
  );
  expect(reloaded.scenes.hero.canvas.backingWidth).toBe(
    Math.round(reloaded.scenes.hero.canvas.cssWidth * Math.min(reloaded.viewport.dpr, 2)),
  );
  expect(reloaded.scenes.hero.canvas.backingHeight).toBe(
    Math.round(reloaded.scenes.hero.canvas.cssHeight * Math.min(reloaded.viewport.dpr, 2)),
  );
});

test("mobile hero prioritizes intro requests before bounded later loading", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Progressive hero loading is covered by the mobile project");
  test.slow();
  await prepareLocalPage(page);
  const requestedFrames: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const frameFixture = readFileSync(path.join(process.cwd(), "Кадры/frame_000_delay-0.067s.webp"));
  await page.route("**/frame_*.webp", async (route) => {
    const match = /frame_(\d+)_/.exec(new URL(route.request().url()).pathname);
    if (match) requestedFrames.push(Number(match[1]));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Keep each batch observable long enough to inspect the queue boundary.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Fulfill from a local immutable fixture rather than retaining a
      // Playwright APIResponse across the artificial delay. This keeps the
      // queue test independent of response-object disposal.
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: frameFixture,
      });
    } finally {
      inFlight -= 1;
    }
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });

  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.requested, { timeout: 5_000 })
    .toBeGreaterThan(0);
  const initial = await snapshot(page);
  expect(initial.scenes.hero.assets.laterQueueStarted).toBe(false);
  // The queue may have advanced through several bounded batches while the
  // polling round-trip completes, but it cannot request any later frame yet.
  expect(initial.scenes.hero.assets.requested).toBeLessThanOrEqual(32);
  expect(maxInFlight).toBeLessThanOrEqual(8);

  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introRequestCountAtReady, { timeout: 20_000 })
    .toBe(32);
  const ready = await snapshot(page);
  expect(ready.scenes.hero.assets.laterQueueStarted).toBe(true);
  expect(ready.scenes.hero.assets.requested).toBeGreaterThanOrEqual(36);
  expect(requestedFrames.slice(0, 32).every((frame) => frame <= 31)).toBe(true);
  expect(requestedFrames.slice(32, 36).every((frame) => frame >= 32)).toBe(true);
});

test("mobile hero bounds the input lock while a partial intro remains loading", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Partial-intro input coverage belongs to mobile projects");
  test.slow();
  await prepareLocalPage(page);
  const pendingFrame = { release: null as (() => void) | null };
  await page.route("**/frame_*.webp", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("frame_001_")) {
      await new Promise<void>((resolve) => {
        pendingFrame.release = resolve;
      });
      await route.continue();
      return;
    }
    if (pathname.includes("frame_000_")) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.loaded, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(31);
  const partial = await snapshot(page);
  expect(partial.scenes.hero.phase).toBe("loading");
  expect(partial.scenes.hero.assets.introReady).toBe(false);
  expect(partial.scenes.hero.assets.pending).toBeGreaterThan(0);
  await expect(page.locator("#scrolly-loader")).not.toHaveClass(/hidden/);

  const partialWheelPrevented = await page.evaluate(() => {
    let observed = false;
    window.addEventListener("wheel", (event) => {
      observed = event.defaultPrevented;
    }, { once: true });
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
    return observed;
  });
  // N1 still owns the first-screen gesture while the bounded readiness
  // watchdog is active, even though this partial state has not painted yet.
  expect(partialWheelPrevented).toBe(true);

  await page.clock.runFor(3_001);
  const released = await snapshot(page);
  expect(released.scenes.hero.phase).toBe("released");
  await expect(page.locator("#scrolly-loader")).toHaveClass(/hidden/);
  pendingFrame.release?.();
  const releasedWheelPrevented = await page.evaluate(() => {
    let observed = false;
    window.addEventListener("wheel", (event) => {
      observed = event.defaultPrevented;
    }, { once: true });
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
    return observed;
  });
  expect(releasedWheelPrevented).toBe(false);
});

test("direct navigation clears the mobile readiness watchdog", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Readiness lifecycle coverage belongs to mobile projects");
  test.slow();
  await prepareLocalPage(page);
  const pendingFrame = { release: null as (() => void) | null };
  await page.route("**/frame_*.webp", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("frame_001_")) {
      await new Promise<void>((resolve) => {
        pendingFrame.release = resolve;
      });
      await route.continue();
      return;
    }
    if (pathname.includes("frame_000_")) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.loaded, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(31);
  const loading = await snapshot(page);
  expect(loading.scenes.hero.phase).toBe("loading");
  expect(loading.scenes.hero.readinessWatchdogPending).toBe(true);

  await page.evaluate(() =>
    document.querySelector<HTMLAnchorElement>('nav a[href="#projects"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
  const released = await snapshot(page);
  expect(released.scenes.hero.phase).toBe("released");
  expect(released.scenes.hero.readinessWatchdogPending).toBe(false);
  pendingFrame.release?.();
  await page.clock.runFor(3_001);
  const afterDeadline = await snapshot(page);
  expect(afterDeadline.scenes.hero.phase).toBe("released");
  expect(afterDeadline.scenes.hero.readinessWatchdogPending).toBe(false);
});

test("mobile hero resumes its asset queue after reduced-motion interruption", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Reduced-motion queue coverage belongs to mobile projects");
  test.slow();
  await prepareLocalPage(page);
  const frameFixture = readFileSync(path.join(process.cwd(), "Кадры/frame_000_delay-0.067s.webp"));
  await page.route("**/frame_*.webp", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 200, contentType: "image/webp", body: frameFixture });
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });

  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.activeRequests, { timeout: 5_000 })
    .toBe(8);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await snapshot(page)).scenes.hero.reducedMotion).toBe(true);
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.activeRequests, { timeout: 5_000 })
    .toBe(0);
  const paused = await snapshot(page);
  expect(paused.scenes.hero.phase).toBe("reduced");
  expect(paused.scenes.hero.assets.introReady).toBe(false);
  const requestsBeforeResume = paused.scenes.hero.assets.requested;

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await snapshot(page)).scenes.hero.reducedMotion).toBe(false);
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.requested, { timeout: 5_000 })
    .toBeGreaterThan(requestsBeforeResume);
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  expect((await snapshot(page)).scenes.hero.phase).toBe("intro");
});

test("mobile hero treats readiness timeout as an inactivity watchdog", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Readiness watchdog coverage belongs to mobile projects");
  test.slow();
  await prepareLocalPage(page);
  const frameFixture = readFileSync(path.join(process.cwd(), "Кадры/frame_000_delay-0.067s.webp"));
  const pendingFrames: Array<{ release: () => void }> = [];
  await page.route("**/frame_*.webp", async (route) => {
    const match = /frame_(\d+)_/.exec(new URL(route.request().url()).pathname);
    const frame = match ? Number(match[1]) : Number.NaN;
    if (frame > 31) {
      await route.abort();
      return;
    }
    await new Promise<void>((resolve) => {
      pendingFrames.push({ release: resolve });
    });
    await route.fulfill({ status: 200, contentType: "image/webp", body: frameFixture });
  });
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.activeRequests, { timeout: 5_000 })
    .toBe(8);

  // Each settlement arrives before the three-second inactivity deadline. The
  // old one-shot timer released at virtual t=3000ms; the corrected watchdog
  // resets at every settlement and therefore remains loading through all
  // these intervals until the final intro frame arrives.
  for (let settled = 1; settled <= 31; settled += 1) {
    await page.clock.runFor(2_500);
    await expect.poll(() => pendingFrames.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const pending = pendingFrames.shift();
    if (!pending) throw new Error("expected a pending intro response");
    pending.release();
    await expect
      .poll(async () => (await snapshot(page)).scenes.hero.assets.loaded, { timeout: 5_000 })
      .toBe(settled);
    expect((await snapshot(page)).scenes.hero.phase).toBe("loading");
  }

  await page.clock.runFor(2_500);
  await expect.poll(() => pendingFrames.length, { timeout: 5_000 }).toBeGreaterThan(0);
  const finalPending = pendingFrames.shift();
  if (!finalPending) throw new Error("expected the final intro response");
  finalPending.release();
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 5_000 })
    .toBe(true);
  expect((await snapshot(page)).scenes.hero.phase).toBe("intro");
});

test("production runtime assets are served without hero degradation", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "One production asset-catalog tape is sufficient");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", { waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.allReady, { timeout: 30_000 })
    .toBe(true);
  const hero = (await snapshot(page)).scenes.hero;
  expect(hero.assets).toMatchObject({ expected: 150, loaded: 150, degraded: false });
  expect(hero.assets.failedAssets).toEqual([]);

  for (const path of [
    "/Кадры/frame_000_delay-0.067s.webp",
    "/icon/figma.svg",
    "/Проекты/Fridj/Slice_1.png",
    "/Проекты/UNNO_eng/screen_1.jpg",
  ]) {
    const response = await page.request.get(path);
    expect(response.ok(), `${path} should be present in the deployable output`).toBe(true);
    expect((await response.body()).byteLength).toBeGreaterThan(0);
  }
});

test("mobile decorative work is excluded from the shared scheduler", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Mobile particle policy is covered by the mobile project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=contact", { waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1600);
  // The adapter keeps one shared-scheduler tick while the ready frame settles.
  // Advance that bounded interpolation before asserting the scene is idle.
  await page.clock.runFor(2500);
  const current = await snapshot(page);
  expect(current.scenes.particles).toMatchObject({
    active: false,
    count: 0,
    pairChecksPerFrame: 0,
    mobileDisabled: true,
  });
  expect(current.scenes.scheduler.activeScenes).not.toContain("particles");
  expect(current.scenes.scheduler.activeScenes).not.toContain("hero");
});

test("an intro frame failure still starts playback and paints fallback copy", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Intro asset failure is covered by the desktop project");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await page.route("**/frame_005_delay-0.067s.webp", (route) => route.abort());
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);

  // At roughly 450ms the intro requests the failed frame's neighborhood. The
  // registry should select a surviving neighbor instead of blanking the canvas.
  await page.clock.runFor(450);
  let current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("intro");
  expect(current.scenes.hero.assets.degraded).toBe(true);
  expect(current.scenes.hero.assets.failedAssets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "frame-005", frame: 5, code: expect.any(String) }),
    ]),
  );
  expect(current.scenes.hero.assets.lastFrameSelection).toEqual(
    expect.objectContaining({
      requestedFrame: expect.any(Number),
      renderedFrame: expect.any(Number),
      usedFallback: true,
      reason: "nearest-ready",
    }),
  );
  expect(current.scenes.hero.assets.lastFrameSelection?.requestedFrame).toBeGreaterThan(2);
  expect(current.scenes.hero.assets.lastFrameSelection?.requestedFrame).toBeLessThan(9);
  expect(current.scenes.hero.assets.lastFrameSelection?.renderedFrame).not.toBe(5);
  expect(await canvasHasPaint(page, "#scrolly-canvas")).toBe(true);
  await expect(page.locator("#st1")).toBeVisible();
  await expect(page.locator("#st2")).toBeVisible();

  await page.clock.runFor(1200);
  current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("ready");
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  expect((await snapshot(page)).scenes.hero.phase).toBe("playing");
  await page.clock.runFor(100);
  expect((await snapshot(page)).scenes.hero.phase).toBe("playing");
});

test("M1 keeps mobile hero geometry stable through visual-height resize", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M1 is the mobile geometry contract");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  const before = await snapshot(page);
  const beforeHero = before.elements.scrolly;
  const beforeCanvas = before.elements["scrolly-canvas"];
  expect(beforeHero).not.toBeNull();
  expect(beforeCanvas).not.toBeNull();
  expect(beforeCanvas!.rect.top).toBeGreaterThanOrEqual(beforeHero!.rect.height * 0.35);
  expect(beforeCanvas!.rect.bottom).toBeCloseTo(beforeHero!.rect.height * 0.85, 1);

  await page.setViewportSize({ width: 390, height: 700 });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.geometry.stableHeight)
    .toBe(before.scenes.hero.geometry.stableHeight);
  const after = await snapshot(page);
  expect(after.scenes.hero.geometry.stableHeight).toBe(before.scenes.hero.geometry.stableHeight);
  expect(after.elements.scrolly?.rect.height).toBeCloseTo(beforeHero!.rect.height, 1);
  expect(after.elements["scrolly-canvas"]?.rect.height).toBeCloseTo(beforeCanvas!.rect.height, 1);
});

test("mobile scrolly and About backgrounds never exceed the live viewport width", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "This is the mobile width-sweep contract");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=contact", { waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1600);

  for (const width of [430, 390, 375, 360, 340, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(async () => (await snapshot(page)).scenes.hero.canvas.cssWidth)
      .toBe(width);
    const effectiveDpr = Math.min((await snapshot(page)).viewport.dpr, 2);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const matrix = (
              document.getElementById("scrolly-canvas") as HTMLCanvasElement | null
            )?.getContext("2d")?.getTransform();
            return matrix
              ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }
              : null;
          }),
      )
      .toEqual({ a: effectiveDpr, b: 0, c: 0, d: effectiveDpr, e: 0, f: 0 });
    const report = await page.evaluate(() => {
      const rect = (id: string) => {
        const value = document.getElementById(id)?.getBoundingClientRect();
        return value ? { left: value.left, right: value.right, width: value.width } : null;
      };
      const rects = (selector: string) =>
        [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
          const value = element.getBoundingClientRect();
          return { selector, left: value.left, right: value.right, width: value.width };
        });
      return {
        innerWidth,
        rootClientWidth: document.documentElement.clientWidth,
        rootScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        scrolly: rect("scrolly"),
        sticky: rect("scrolly-sticky"),
        heroCanvas: rect("scrolly-canvas"),
        heroTransform: (() => {
          const canvas = document.getElementById("scrolly-canvas") as HTMLCanvasElement | null;
          const matrix = canvas?.getContext("2d")?.getTransform();
          return matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null;
        })(),
        about: rect("about"),
        particles: rect("pcanvas"),
        heroLayers: [
          "scrolly-loader",
          "st1",
          "st2",
          "explore-cta",
          "scroll-hint",
          "photo-strip",
          "noise-top",
        ].map(rect),
        responsiveContent: rects("#about .sw, .pgrid, .pcard, #ctitle-3d"),
      };
    });
    const diagnostics = await snapshot(page);
    expect(report.rootScrollWidth).toBeLessThanOrEqual(report.rootClientWidth);
    expect(report.bodyScrollWidth).toBeLessThanOrEqual(report.rootClientWidth);
    for (const element of [
      report.scrolly,
      report.sticky,
      report.heroCanvas,
      report.about,
      report.particles,
      ...report.heroLayers,
    ]) {
      expect(element).not.toBeNull();
      expect(element!.left).toBeGreaterThanOrEqual(-1);
      expect(element!.right).toBeLessThanOrEqual(report.innerWidth + 1);
      expect(element!.width).toBeLessThanOrEqual(report.innerWidth + 1);
    }
    for (const element of report.responsiveContent) {
      expect(element.left, `${element.selector} projects left of the viewport`).toBeGreaterThanOrEqual(-1);
      expect(element.right, `${element.selector} projects right of the viewport`).toBeLessThanOrEqual(
        report.innerWidth + 1,
      );
    }
    expect(diagnostics.scenes.hero.canvas.cssWidth).toBe(width);
    expect(diagnostics.scenes.hero.canvas.backingWidth).toBe(
      Math.round(width * Math.min(diagnostics.viewport.dpr, 2)),
    );
    expect(report.heroTransform).toEqual({
      a: Math.min(diagnostics.viewport.dpr, 2),
      b: 0,
      c: 0,
      d: Math.min(diagnostics.viewport.dpr, 2),
      e: 0,
      f: 0,
    });
  }
});

test("mobile timeline years and readable content stay inside the shared section gutter", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "The timeline gutter contract is mobile-specific");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles,contact", {
    waitUntil: "domcontentloaded",
  });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("#timeline").scrollIntoViewIfNeeded();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.clientWidth))
      .toBe(width);
    const report = await page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>("#timeline .tl-sw");
      if (!wrapper) throw new Error("Timeline wrapper is missing");
      const wrapperStyle = getComputedStyle(wrapper);
      const gutter = wrapper.getBoundingClientRect().left +
        Number.parseFloat(wrapperStyle.paddingLeft || "0");
      const probe = (window as typeof window & {
        __portfolioVisualProbe?: () => {
          insets: {
            timelineSemantic?: {
              complete: boolean;
              rowCount: number;
              rows: Array<{
                id: string;
                year: { left: number; right?: number; visible: boolean; readable: boolean; width: number; height: number };
                body: { left: number; right?: number; visible: boolean; readable: boolean; width: number; height: number };
                readableBodyDescendants: Array<{ left: number; visible: boolean; readable: boolean; width: number; height: number }>;
              }>;
              header: { left: number; visible: boolean; readable: boolean; width: number; height: number } | null;
              title: { left: number; visible: boolean; readable: boolean; width: number; height: number } | null;
            };
          };
        };
      }).__portfolioVisualProbe?.();
      const semantic = probe?.insets.timelineSemantic;
      if (!semantic) throw new Error("Timeline semantic probe is missing");
      const domRows = [...document.querySelectorAll<HTMLElement>("#timeline .tl-row")];
      return {
        gutter,
        semantic,
        domRowCount: domRows.length,
        domRowIds: domRows.map((_, index) => `timeline-row-${index}`),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth);
    expect(report.semantic.complete).toBe(true);
    expect(report.semantic.header).not.toBeNull();
    expect(report.semantic.title).not.toBeNull();
    expect(report.semantic.rowCount).toBe(report.domRowCount);
    expect(report.semantic.rows).toHaveLength(report.domRowCount);
    expect(report.semantic.rows.map((row) => row.id)).toEqual(report.domRowIds);
    expect(report.semantic.header).toMatchObject({ visible: true, readable: true });
    expect(report.semantic.title).toMatchObject({ visible: true, readable: true });

    const anchors = [
      report.semantic.header,
      report.semantic.title,
      ...report.semantic.rows.flatMap((row) => [
        row.year,
        row.body,
        ...row.readableBodyDescendants,
      ]),
    ].filter((anchor): anchor is NonNullable<typeof anchor> => anchor !== null);
    for (const anchor of anchors) {
      expect(anchor.visible, `${anchor.left} anchor is hidden`).toBe(true);
      expect(anchor.readable, `${anchor.left} anchor is not readable`).toBe(true);
      expect(anchor.width).toBeGreaterThan(0);
      expect(anchor.height).toBeGreaterThan(0);
      expect(anchor.left, "timeline content starts before its shared gutter").toBeGreaterThanOrEqual(
        report.gutter - 1,
      );
      const right = "right" in anchor && typeof anchor.right === "number"
        ? anchor.right
        : anchor.left + anchor.width;
      expect(right, "timeline content exceeds the viewport").toBeLessThanOrEqual(
        report.clientWidth + 1,
      );
    }
  }
});

test("desktop particle canvas tracks live viewport and DPR without coordinate squeeze", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Particles are intentionally disabled on mobile");
  await prepareLocalPage(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,contact", { waitUntil: "domcontentloaded" });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 760 },
    { width: 1024, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await snapshot(page)).scenes.particles.cssWidth).toBe(viewport.width);
    const current = await snapshot(page);
    const effectiveDpr = Math.min(current.viewport.dpr, 2);
    expect(current.scenes.particles).toMatchObject({
      cssWidth: viewport.width,
      cssHeight: viewport.height,
      dpr: effectiveDpr,
      backingWidth: Math.round(viewport.width * effectiveDpr),
      backingHeight: Math.round(viewport.height * effectiveDpr),
    });
    const transform = await page.locator("#pcanvas").evaluate((element) => {
      const matrix = (element as HTMLCanvasElement).getContext("2d")?.getTransform();
      return matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null;
    });
    expect(transform).toEqual({ a: effectiveDpr, b: 0, c: 0, d: effectiveDpr, e: 0, f: 0 });
  }
});

test("mobile hero consumes early touch input before the semantic handoff", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Touch scrolling is covered by mobile projects");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  const defaultPrevented = await page.evaluate(() => {
    const first = new Touch({
      identifier: 1,
      target: document.body,
      clientX: 195,
      clientY: 600,
    });
    window.dispatchEvent(
      new TouchEvent("touchstart", { touches: [first], cancelable: true, bubbles: true }),
    );
    const moved = new Touch({
      identifier: 1,
      target: document.body,
      clientX: 195,
      clientY: 500,
    });
    const event = new TouchEvent("touchmove", {
      touches: [moved],
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(defaultPrevented).toBe(true);
});

test("mobile native scrolling advances over hero and Skills while an offscreen hero stays inert", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Native scroll lifecycle is covered by the mobile project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1_600);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  const heroStart = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(heroStart);
  expect((await snapshot(page)).scenes.hero.phase).toBe("playing");
  await page.clock.runFor(1_400);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(heroStart);

  await page.locator("#skillcanvas").scrollIntoViewIfNeeded();
  const skillsStart = await page.evaluate(() => window.scrollY);
  const skillsBox = await page.locator("#skillcanvas").boundingBox();
  expect(skillsBox).not.toBeNull();
  await page.mouse.move(skillsBox!.x + skillsBox!.width / 2, skillsBox!.y + skillsBox!.height / 2);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(skillsStart);

  await page.locator("#about").scrollIntoViewIfNeeded();
  const before = await snapshot(page);
  const wheelPrevented = await page.locator("#about").evaluate((about) => {
    let observed: boolean | null = null;
    const observe = (event: Event) => {
      observed = event.defaultPrevented;
    };
    window.addEventListener("wheel", observe, { once: true });
    about.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    return observed;
  });
  const after = await snapshot(page);
  expect(wheelPrevented).toBe(false);
  expect(after.scenes.hero.phase).toBe(before.scenes.hero.phase);
  expect(after.scenes.hero.exitHoldPending).toBe(false);
});

test("hero reports degraded assets and uses the nearest ready frame", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Asset fallback is covered by the desktop project");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await page.route("**/frame_149_delay-0.067s.webp", (route) => route.abort());
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.degraded, { timeout: 20_000 })
    .toBe(true);

  let current = await snapshot(page);
  expect(current.scenes.hero.assets.failedAssets.some((asset) => asset.key === "frame-149")).toBe(true);
  expect(current.scenes.hero.assets.fallbackCount).toBeGreaterThanOrEqual(0);

  await page.clock.runFor(1600);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  await page.clock.runFor(3600);
  current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("complete");
  expect(current.scenes.hero.assets.fallbackCount).toBeGreaterThan(0);
  const selection = current.scenes.hero.assets.lastFrameSelection;
  expect(selection).toMatchObject({ usedFallback: true, reason: "nearest-ready" });
  expect(selection?.requestedFrame).toBeGreaterThan(140);
  expect(selection?.renderedFrame).toBeGreaterThanOrEqual(0);
  expect(selection?.renderedFrame).toBeLessThan(149);
});

test("M2-M3 replace mobile copy then latch Explore work availability", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M2-M3 are the mobile choreography contract");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1600);
  let current = await snapshot(page);
  expect(current.scenes.hero.overlays.roleOpacity).toBeCloseTo(1, 2);
  expect(current.scenes.hero.overlays.experienceOpacity).toBeCloseTo(0, 2);
  expect(current.elements.st1?.style).toMatchObject({ display: "block", visibility: "visible", opacity: "1" });
  expect(current.elements.st2?.style.opacity).toBe("0");
  expect(current.scenes.hero.phase).toBe("ready");
  await expect(page.locator("#st-reduced")).toBeHidden();
  const roleStateRect = current.elements.st1!.rect;
  const experienceStateRect = current.elements.st2!.rect;
  const initialCanvasRect = current.elements["scrolly-canvas"]!.rect;
  expect(roleStateRect.top).toBeCloseTo(experienceStateRect.top, 1);
  expect(roleStateRect.x + roleStateRect.width / 2).toBeCloseTo(current.viewport.innerWidth / 2, 1);
  expect(roleStateRect.bottom).toBeLessThanOrEqual(initialCanvasRect.top);
  const roleScreenshot = await page.screenshot({ animations: "allow" });
  writeBaseline(testInfo.project.name, "hero-role-state.json", `${JSON.stringify(current, null, 2)}\n`);
  writeBaseline(testInfo.project.name, "hero-role.png", roleScreenshot);

  await page.evaluate(() =>
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })),
  );
  expect((await snapshot(page)).scenes.scheduler.activeScenes).toContain("hero");
  await page.clock.runFor(1900);
  current = await snapshot(page);
  expect(current.scenes.hero.overlays.roleOpacity).toBeCloseTo(0, 2);
  expect(current.scenes.hero.overlays.experienceOpacity).toBeGreaterThan(0.95);
  expect(current.elements.st1?.style.opacity).toBe("0");
  expect(current.elements.st2?.style).toMatchObject({ display: "block", visibility: "visible", opacity: "1" });
  expect(current.scenes.hero.overlays.ctaAvailable).toBe(false);
  const roleRect = current.elements.st1!.rect;
  const experienceRect = current.elements.st2!.rect;
  const canvasRect = current.elements["scrolly-canvas"]!.rect;
  expect(roleRect.top).toBeCloseTo(experienceRect.top, 1);
  expect(roleRect.x + roleRect.width / 2).toBeCloseTo(current.viewport.innerWidth / 2, 1);
  expect(experienceRect.x + experienceRect.width / 2).toBeCloseTo(current.viewport.innerWidth / 2, 1);
  expect(roleRect.bottom).toBeLessThanOrEqual(canvasRect.top);
  expect(experienceRect.bottom).toBeLessThanOrEqual(canvasRect.top);
  expect(
    current.scenes.hero.overlays.roleOpacity > 0 &&
      current.scenes.hero.overlays.experienceOpacity > 0,
  ).toBe(false);
  const experienceScreenshot = await page.screenshot({ animations: "allow" });
  writeBaseline(testInfo.project.name, "hero-experience-state.json", `${JSON.stringify(current, null, 2)}\n`);
  writeBaseline(testInfo.project.name, "hero-experience.png", experienceScreenshot);

  await page.clock.runFor(1000);
  current = await snapshot(page);
  expect(current.scenes.hero.overlays.ctaAvailable).toBe(true);
  expect(current.scenes.hero.overlays.ctaOpacity).toBe(1);
  expect(current.scenes.hero.overlays.ctaPointerEvents).toBe("all");
  const cta = page.locator("#explore-cta a");
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  const screenshot = await page.screenshot({ animations: "allow" });
  writeBaseline(testInfo.project.name, "hero-experience-cta-state.json", `${JSON.stringify(current, null, 2)}\n`);
  writeBaseline(testInfo.project.name, "hero-experience-cta.png", screenshot);
});

test("completed playback retains terminal experience copy through normal exit", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Terminal copy persistence is a mobile presentation contract");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);

  await page.clock.runFor(1_600);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  await page.clock.runFor(3_600);
  let current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({ phase: "complete", playbackCompleted: true });
  expect(current.scenes.hero.overlays.experienceOpacity).toBe(1);
  await expect(page.locator("#st2")).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  expect((await snapshot(page)).scenes.hero).toMatchObject({ phase: "exit-hold", playbackCompleted: true });
  expect((await snapshot(page)).scenes.hero.overlays.experienceOpacity).toBe(1);
  await page.clock.runFor(750);
  current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({ phase: "released", playbackCompleted: true });
  expect(current.scenes.hero.overlays.experienceOpacity).toBe(1);
  await expect(page.locator("#st2")).toBeVisible();
  await expect(page.locator("#st2")).toContainText("14+");
});

test("mobile terminal copy never blinks while completion exits and releases", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Terminal copy persistence is a mobile presentation contract");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);

  await page.clock.runFor(1_600);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));

  type CopySample = {
    tag: "transition" | "return";
    phase: string;
    playbackCompleted: boolean;
    modelOpacity: number;
    computedOpacity: number;
    visible: boolean;
    width: number;
    height: number;
    text: string;
    inViewport: boolean;
  };

  // Sample inside the browser at each fake-vsync quantum. This keeps the
  // rendered seam dense without paying a protocol round-trip per frame, and
  // reads phase/latch/model opacity from the same public diagnostics object.
  await page.clock.runFor(1_800);
  await page.evaluate(() => {
    const element = document.getElementById("st2");
    if (!element) throw new Error("#st2 is missing");
    const diagnostics = (window as typeof window & {
      __portfolioMotion?: { snapshot(): DiagnosticsSnapshot };
      __terminalCopySampler?: {
        samples: CopySample[];
        capture: (tag?: CopySample["tag"]) => void;
        timer: number;
      };
    }).__portfolioMotion;
    if (!diagnostics) throw new Error("Motion diagnostics are not enabled");
    const samples: CopySample[] = [];
    const capture = (tag: CopySample["tag"] = "transition"): void => {
      const hero = diagnostics.snapshot().scenes.hero;
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const intersectionWidth = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left));
      const intersectionHeight = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
      samples.push({
        tag,
        phase: hero.phase,
        playbackCompleted: hero.playbackCompleted,
        modelOpacity: hero.overlays.experienceOpacity,
        computedOpacity: Number.parseFloat(computed.opacity),
        visible: computed.display !== "none" && computed.visibility !== "hidden",
        width: rect.width,
        height: rect.height,
        text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
        inViewport: intersectionWidth > 0 && intersectionHeight > 0,
      });
    };
    capture();
    const timer = window.setInterval(capture, 16);
    (window as typeof window & {
      __terminalCopySampler?: {
        samples: CopySample[];
        capture: (tag?: CopySample["tag"]) => void;
        timer: number;
      };
    }).__terminalCopySampler = { samples, capture, timer };
  });

  await page.clock.runFor(1_800);
  let current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("complete");
  expect(current.scenes.hero.playbackCompleted).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  expect((await snapshot(page)).scenes.hero).toMatchObject({ phase: "exit-hold", playbackCompleted: true });
  await page.clock.runFor(750);
  await page.clock.runFor(16);
  current = await snapshot(page);
  expect(current.scenes.hero.phase).toBe("released");
  expect(current.scenes.hero.playbackCompleted).toBe(true);
  const samples = await page.evaluate(() => {
    const sampler = (window as typeof window & {
      __terminalCopySampler?: {
        samples: CopySample[];
        capture: (tag?: CopySample["tag"]) => void;
        timer: number;
      };
    }).__terminalCopySampler;
    if (!sampler) throw new Error("Terminal copy sampler is missing");
    window.clearInterval(sampler.timer);
    return sampler.samples;
  });
  expect(samples.length).toBeGreaterThan(100);
  expect(samples.some((sample) => sample.phase === "complete")).toBe(true);
  expect(samples.some((sample) => sample.phase === "exit-hold")).toBe(true);
  expect(samples.some((sample) => sample.phase === "released")).toBe(true);
  const playingSamples = samples.filter((sample) => sample.phase === "playing");
  expect(playingSamples.length).toBeGreaterThan(10);
  expect(playingSamples.every((sample) => !sample.playbackCompleted)).toBe(true);
  expect(samples.filter((sample) => sample.phase !== "playing").every((sample) => sample.playbackCompleted)).toBe(true);
  samples.forEach((sample, index) => {
    expect(sample.text, `terminal copy text at sample ${index} (${sample.phase})`).toContain("14+");
    if (sample.phase !== "released") {
      expect(sample.inViewport, `terminal copy viewport intersection at sample ${index} (${sample.phase})`).toBe(true);
    }
    expect(sample.visible, `terminal copy visibility at sample ${index} (${sample.phase})`).toBe(true);
    expect(sample.width, `terminal copy width at sample ${index} (${sample.phase})`).toBeGreaterThan(0);
    expect(sample.height, `terminal copy height at sample ${index} (${sample.phase})`).toBeGreaterThan(0);
    expect(sample.modelOpacity, `model opacity at sample ${index} (${sample.phase})`).toBeGreaterThanOrEqual(0.99);
    expect(sample.computedOpacity, `terminal copy opacity at sample ${index} (${sample.phase})`).toBeGreaterThanOrEqual(0.99);
  });
  expect(Math.min(...samples.map((sample) => sample.modelOpacity))).toBeGreaterThanOrEqual(0.99);
  expect(Math.min(...samples.map((sample) => sample.computedOpacity))).toBeGreaterThanOrEqual(0.99);

  await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    root.style.scrollBehavior = "auto";
    body.style.scrollBehavior = "auto";
    window.scrollTo({ top: 0, behavior: "auto" });
  });
  await page.clock.runFor(16);
  const returnSample = await page.evaluate(() => {
    const sampler = (window as typeof window & {
      __terminalCopySampler?: {
        samples: CopySample[];
        capture: (tag?: CopySample["tag"]) => void;
        timer: number;
      };
    }).__terminalCopySampler;
    if (!sampler) throw new Error("Terminal copy sampler is missing");
    sampler.capture("return");
    return sampler.samples.at(-1);
  });
  expect(returnSample).toMatchObject({
    tag: "return",
    phase: "released",
    playbackCompleted: true,
    modelOpacity: 1,
    computedOpacity: expect.any(Number),
    visible: true,
    inViewport: true,
    text: expect.stringContaining("14+"),
  });
  expect(returnSample!.computedOpacity).toBeGreaterThanOrEqual(0.99);
  expect(returnSample!.width).toBeGreaterThan(0);
  expect(returnSample!.height).toBeGreaterThan(0);
});

test("early direct navigation releases without claiming completed terminal copy", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Terminal copy persistence is a mobile presentation contract");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1_600);
  expect((await snapshot(page)).scenes.hero.phase).toBe("ready");

  await page.evaluate(() =>
    document.querySelector<HTMLAnchorElement>('nav a[href="#projects"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
  const current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({ phase: "released", playbackCompleted: false });
  expect(current.scenes.hero.overlays.experienceOpacity).toBe(0);
  expect(current.elements.st2?.style.opacity).toBe("0");
});

test("hero exit hold is canceled by direct navigation", async ({ page }) => {
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1600);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  await page.clock.runFor(3600);
  expect((await snapshot(page)).scenes.hero.phase).toBe("complete");

  await page.evaluate(() => {
    let calls = 0;
    const original = window.scrollTo.bind(window);
    Object.defineProperty(window, "__testScrollToCalls", {
      configurable: true,
      get: () => calls,
    });
    window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
      calls += 1;
      original(...args);
    }) as typeof window.scrollTo;
  });
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  expect((await snapshot(page)).scenes.hero.phase).toBe("exit-hold");
  expect((await snapshot(page)).scenes.hero.exitHoldPending).toBe(true);

  await page.evaluate(() => document.querySelector('nav a[href="#projects"]')?.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  })));
  expect((await snapshot(page)).scenes.hero.phase).toBe("released");
  expect((await snapshot(page)).scenes.hero.exitHoldPending).toBe(false);
  expect((await snapshot(page)).scenes.scheduler.activeScenes).not.toContain("hero");
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as typeof window & { __testScrollToCalls: number }).__testScrollToCalls)).toBe(0);
});

test("persisted pagehide keeps the motion app resumable for BFCache", async ({ page }) => {
  test.setTimeout(60_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);

  await page.clock.runFor(100);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  expect((await snapshot(page)).scenes.scheduler.hidden).toBe(true);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await page.clock.runFor(100);
  const restored = await snapshot(page);
  expect(restored.scenes.scheduler.hidden).toBe(false);
  expect(restored.scenes.hero.phase).toBe("intro");
  expect(restored.scenes.scheduler.activeScenes).toContain("hero");
});

test("Tools & Skills reports whether startup actually occurred", async ({ page }, testInfo) => {
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles,contact#skills", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#skills").scrollIntoViewIfNeeded();
  await page.clock.runFor(50);
  await expect
    .poll(async () => (await snapshot(page)).scenes.skills.started, { timeout: 10_000 })
    .toBe(true);
  await page.clock.runFor(1300);

  const current = await snapshot(page);
  expect(current.scenes.skills.width).toBeGreaterThan(0);
  expect(current.scenes.skills.height).toBeGreaterThan(0);
  expect(current.scenes.skills.seed).toBe(20_260_825);
  expect(current.scenes.skills.active).toBe(true);
  expect(current.scenes.skills.iconAssetsLoaded).toBeGreaterThanOrEqual(0);
  expect(current.scenes.skills.iconAssetsPending).toEqual(expect.any(Array));
  expect(current.scenes.skills.iconAssetsFailed).toEqual(expect.any(Array));
  expect(current.scenes.skills.assetReadiness.fallbackCount).toBeGreaterThanOrEqual(0);
  if (current.scenes.skills.assetReadiness.degraded) {
    expect(current.scenes.skills.assetReadiness.failedAssets.length).toBeGreaterThan(0);
  }
  expect(current.scenes.skills.chips.length).toBeGreaterThan(0);
  for (const chip of current.scenes.skills.chips) {
    expect(Number.isFinite(chip.x)).toBe(true);
    expect(Number.isFinite(chip.y)).toBe(true);
  }

  const stateJson = Buffer.from(`${JSON.stringify(current.scenes.skills, null, 2)}\n`);
  const screenshot = await page.screenshot({ animations: "allow" });
  await testInfo.attach("skills-state.json", {
    body: stateJson,
    contentType: "application/json",
  });
  await testInfo.attach("skills.png", {
    body: screenshot,
    contentType: "image/png",
  });
  writeBaseline(testInfo.project.name, "skills-state.json", stateJson);
  writeBaseline(testInfo.project.name, "skills.png", screenshot);

  const touchPrevented = await page.locator("#skillcanvas").evaluate((canvas) => {
    const touch = new Touch({ identifier: 2, target: canvas, clientX: 100, clientY: 100 });
    const event = new TouchEvent("touchmove", {
      touches: [touch],
      cancelable: true,
      bubbles: true,
    });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(touchPrevented).toBe(false);

  await page.locator("#about").scrollIntoViewIfNeeded();
  await page.clock.runFor(50);
  const paused = await snapshot(page);
  expect(paused.scenes.skills.active).toBe(false);
  expect(paused.scenes.skills.phase).toBe("paused");
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);

  await page.setViewportSize({ width: 390, height: 700 });
  await page.clock.runFor(50);
  const pausedAfterResize = await snapshot(page);
  expect(pausedAfterResize.scenes.skills.active).toBe(false);
  expect(pausedAfterResize.scenes.skills.phase).toBe("paused");
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);
});

test("a failed Figma icon reports degradation while canvas and semantic labels remain available", async ({ page }) => {
  await prepareLocalPage(page);
  await page.route("**/icon/figma.svg", (route) => route.abort());
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles,contact#skills", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#skills").scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await snapshot(page)).scenes.skills.started, { timeout: 10_000 })
    .toBe(true);
  await page.clock.runFor(1300);

  const current = await snapshot(page);
  expect(current.scenes.skills.assetReadiness.degraded).toBe(true);
  expect(current.scenes.skills.iconAssetsFailed).toContain("icon/figma.svg");
  expect(current.scenes.skills.assetReadiness.failedAssets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "icon/figma.svg", code: expect.any(String) }),
    ]),
  );
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);
  const semanticFigma = page.locator('#skills ul[aria-label="Tools and skills"] li', { hasText: "Figma" });
  await expect(semanticFigma).toHaveCount(1);
  await expect(semanticFigma).toHaveText("Figma");
});

test("scene isolation names disabled Skills and timeline without scheduler work", async ({ page }) => {
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto(
    "/?motionDiagnostics=1&motionDisable=hero,particles,contact,skills,timeline",
    { waitUntil: "domcontentloaded" },
  );

  const current = await snapshot(page);
  expect(current.scenes.skills).toMatchObject({
    started: false,
    active: false,
    disabled: true,
    reason: "disabled-for-scene-isolation",
    needsFrame: false,
  });
  expect(current.scenes.timeline).toMatchObject({
    active: false,
    disabled: true,
    reason: "disabled-for-scene-isolation",
    updateCount: 0,
  });
  expect(current.scenes.scheduler).toMatchObject({
    activeScenes: [],
    activeSceneNames: [],
    pendingFrame: false,
    totalTicks: 0,
  });
  expect(current.scenes.scheduler.sceneTicks.skills).toBe(0);
  expect(current.scenes.scheduler.sceneTicks.timeline).toBeUndefined();
});

test("M4 reduced motion renders deterministic static skills without scheduling", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M4's ten-chip layout is the mobile contract");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles,contact#skills", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#skills").scrollIntoViewIfNeeded();
  await page.clock.runFor(50);
  await expect.poll(async () => (await snapshot(page)).scenes.skills.started).toBe(true);
  const current = await snapshot(page);
  expect(current.scenes.skills).toMatchObject({
    phase: "settled",
    active: false,
    reducedMotion: true,
    seed: 20_260_825,
  });
  expect(current.scenes.skills.chips.length).toBe(10);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.runFor(50);
  await expect
    .poll(async () => (await snapshot(page)).scenes.skills.mobileModel, { timeout: 5_000 })
    .toBe(false);
  let desktopReduced = await snapshot(page);
  expect(desktopReduced.scenes.skills).toMatchObject({ active: false, mobileModel: false });
  expect(desktopReduced.scenes.skills.chips.length).toBe(15);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);

  await page.setViewportSize({ width: 390, height: 700 });
  await page.clock.runFor(50);
  await expect
    .poll(async () => (await snapshot(page)).scenes.skills.mobileModel, { timeout: 5_000 })
    .toBe(true);
  const mobileReduced = await snapshot(page);
  expect(mobileReduced.scenes.skills).toMatchObject({ active: false, mobileModel: true });
  expect(mobileReduced.scenes.skills.chips.length).toBe(10);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);
  writeBaseline(
    testInfo.project.name,
    "skills-reduced-state.json",
    `${JSON.stringify(current.scenes.skills, null, 2)}\n`,
  );
  writeBaseline(
    testInfo.project.name,
    "skills-reduced.png",
    await page.screenshot({ animations: "allow" }),
  );
});

test("Skills rebuilds its model when crossing the mobile breakpoint", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Breakpoint crossing starts from the desktop project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles,contact#skills", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#skills").scrollIntoViewIfNeeded();
  await expect.poll(async () => (await snapshot(page)).scenes.skills.started).toBe(true);
  let current = await snapshot(page);
  expect(current.scenes.skills.mobileModel).toBe(false);
  expect(current.scenes.skills.chips.length).toBe(15);

  await page.setViewportSize({ width: 375, height: 844 });
  await page.clock.runFor(50);
  current = await snapshot(page);
  expect(current.scenes.skills.mobileModel).toBe(true);
  expect(current.scenes.skills.chips.length).toBe(10);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.runFor(50);
  current = await snapshot(page);
  expect(current.scenes.skills.mobileModel).toBe(false);
  expect(current.scenes.skills.chips.length).toBe(15);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);
});

test("whole-page reduced motion keeps essentials and stops decorative loops", async ({ page }) => {
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?motionDiagnostics=1#skills", { waitUntil: "domcontentloaded" });

  const current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({
    active: false,
    autoplay: false,
    reducedMotion: true,
    phase: "reduced",
  });
  expect(current.scenes.hero.overlays).toMatchObject({
    roleOpacity: 1,
    experienceOpacity: 1,
    ctaAvailable: true,
    ctaOpacity: 1,
    ctaPointerEvents: "all",
  });
  expect(current.scenes.particles).toMatchObject({
    active: false,
    count: 0,
    reducedMotion: true,
  });
  expect(current.scenes.contact).toMatchObject({ active: false, reducedMotion: true });
  expect(current.scenes.timeline).toMatchObject({
    active: false,
    reducedMotion: true,
    updateCount: 0,
    rowsVisible: 5,
    fillHeight: "100%",
    cursorTop: "100%",
  });
  expect(current.scenes.scheduler).toMatchObject({
    activeScenes: [],
    pendingFrame: false,
    reducedMotion: true,
    hidden: false,
  });
  await expect(page.locator("#explore-cta a")).toBeVisible();
  if (current.viewport.innerWidth <= 768) {
    await expect(page.locator("#st1")).toBeHidden();
    await expect(page.locator("#st2")).toBeHidden();
    await expect(page.locator("#st-reduced")).toBeVisible();
    const reducedCopy = current.elements["st-reduced"]?.rect;
    const reducedCanvas = current.elements["scrolly-canvas"]?.rect;
    expect(reducedCopy).not.toBeNull();
    expect(reducedCanvas).not.toBeNull();
    expect(reducedCopy!.bottom).toBeLessThanOrEqual(reducedCanvas!.top);
  }
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

  const timelineBeforeScroll = current.scenes.timeline;
  await page.locator("#timeline").scrollIntoViewIfNeeded();
  await page.clock.runFor(250);
  const timelineAfterScroll = (await snapshot(page)).scenes.timeline;
  expect(timelineAfterScroll).toEqual(timelineBeforeScroll);

  await page.locator("#skills").scrollIntoViewIfNeeded();
  await page.clock.runFor(50);
  const skills = await snapshot(page);
  expect(skills.scenes.skills).toMatchObject({ phase: "settled", active: false, reducedMotion: true });
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);
});

test("reduced-motion interruption cancels exit hold and preserves terminal navigation", async ({ page }) => {
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(async () => (await snapshot(page)).scenes.hero.assets.introReady, { timeout: 20_000 })
    .toBe(true);
  await page.clock.runFor(1600);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  await page.clock.runFor(3600);
  expect((await snapshot(page)).scenes.hero.phase).toBe("complete");
  await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })));
  expect((await snapshot(page)).scenes.hero).toMatchObject({ phase: "exit-hold", exitHoldPending: true });

  const scrollBeforeToggle = await page.evaluate(() => window.scrollY);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await snapshot(page)).scenes.hero.reducedMotion).toBe(true);
  let current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({
    phase: "reduced",
    exitHoldPending: false,
    active: false,
  });
  expect(current.scenes.scheduler.activeScenes).not.toContain("hero");
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeToggle);
  expect((await snapshot(page)).scenes.hero.phase).toBe("reduced");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await snapshot(page)).scenes.hero.reducedMotion).toBe(false);
  current = await snapshot(page);
  expect(current.scenes.hero).toMatchObject({
    phase: "complete",
    exitHoldPending: false,
  });
  expect(current.scenes.hero.overlays.ctaAvailable).toBe(true);
});

test("contact schedules only while easing to a new target", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Pointer lifecycle is covered by the desktop project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,particles", { waitUntil: "domcontentloaded" });

  expect((await snapshot(page)).scenes.scheduler.activeScenes).not.toContain("contact");
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, clientY: 140 }));
  });
  expect((await snapshot(page)).scenes.scheduler.activeScenes).toContain("contact");
  await page.clock.runFor(2_000);
  const settled = await snapshot(page);
  expect(settled.scenes.contact?.active).toBe(false);
  expect(settled.scenes.scheduler.activeScenes).not.toContain("contact");
  expect(settled.scenes.scheduler.pendingFrame).toBe(false);
});

test("hidden documents pause every scheduler scene", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Visibility lifecycle is covered by the desktop project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=hero,contact", { waitUntil: "domcontentloaded" });
  const before = await snapshot(page);
  expect(before.scenes.scheduler.activeScenes).toContain("particles");

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await snapshot(page);
  expect(hidden.scenes.scheduler).toMatchObject({ hidden: true, activeScenes: [], pendingFrame: false });

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const visible = await snapshot(page);
  expect(visible.scenes.scheduler.hidden).toBe(false);
  expect(visible.scenes.scheduler.activeScenes).toContain("particles");
});

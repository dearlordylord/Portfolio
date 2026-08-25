import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
      displayFrame: number;
      targetFrame: number;
      assets: {
        introReady: boolean;
        loaded: number;
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
      canvas: { cssWidth: number; cssHeight: number; backingWidth: number; backingHeight: number };
    };
    particles: {
      active: boolean;
      count: number;
      pairChecksPerFrame: number;
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
  await expect(page.locator("#case-images img")).toHaveCount(17);

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
  await page.clock.runFor(34);
  const after = await snapshot(page);
  expect(after.scenes.hero.geometry.stableHeight).toBe(before.scenes.hero.geometry.stableHeight);
  expect(after.elements.scrolly?.rect.height).toBeCloseTo(beforeHero!.rect.height, 1);
  expect(after.elements["scrolly-canvas"]?.rect.height).toBeCloseTo(beforeCanvas!.rect.height, 1);
});

test("mobile hero does not cancel native touch scrolling", async ({ page }, testInfo) => {
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
  expect(defaultPrevented).toBe(false);
});

test("mobile native scrolling advances over hero and Skills while an offscreen hero stays inert", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "Native scroll lifecycle is covered by the mobile project");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  const heroStart = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 500);
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

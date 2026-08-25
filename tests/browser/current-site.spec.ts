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
      assets: { introReady: boolean; loaded: number; expected: number };
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
    particles: { active: boolean; count: number; pairChecksPerFrame: number; reducedMotion?: boolean };
    contact?: { active: boolean; reducedMotion?: boolean; reason?: string };
    timeline?: {
      active: boolean;
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
      chips: Array<{ label: string; x: number; y: number; r: number }>;
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
  expect(await page.evaluate(() => "__portfolioMotion" in window)).toBe(false);
});

test("hero ready state is deterministic and inspectable", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await prepareLocalPage(page);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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
  expect(current.scenes.particles).toMatchObject({ active: false, count: 0, pairChecksPerFrame: 0 });
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

test("M1 keeps mobile hero geometry stable through visual-height resize", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M1 is the mobile geometry contract");
  await prepareLocalPage(page);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,contact", {
    waitUntil: "domcontentloaded",
  });
  const before = await snapshot(page);
  const beforeHero = before.elements.scrolly;
  const beforeCanvas = before.elements["scrolly-canvas"];
  expect(beforeHero).not.toBeNull();
  expect(beforeCanvas).not.toBeNull();

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
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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

test("M2-M3 replace mobile copy then latch Explore work availability", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M2-M3 are the mobile choreography contract");
  test.setTimeout(120_000);
  await prepareLocalPage(page);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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

  await page.evaluate(() =>
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true })),
  );
  await page.clock.runFor(1900);
  current = await snapshot(page);
  expect(current.scenes.hero.overlays.roleOpacity).toBeCloseTo(0, 2);
  expect(current.scenes.hero.overlays.experienceOpacity).toBeGreaterThan(0.95);
  expect(current.scenes.hero.overlays.ctaAvailable).toBe(false);
  expect(current.elements.st1?.rect.top).toBeCloseTo(current.elements.st2!.rect.top, 1);
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
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => (window as typeof window & { __testScrollToCalls: number }).__testScrollToCalls)).toBe(0);
});

test("Tools & Skills reports whether startup actually occurred", async ({ page }, testInfo) => {
  await prepareLocalPage(page);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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

test("M4 reduced motion renders deterministic static skills without scheduling", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "M4's ten-chip layout is the mobile contract");
  await prepareLocalPage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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
  let desktopReduced = await snapshot(page);
  expect(desktopReduced.scenes.skills).toMatchObject({ active: false, mobileModel: false });
  expect(desktopReduced.scenes.skills.chips.length).toBe(15);
  expect(await canvasHasPaint(page, "#skillcanvas")).toBe(true);

  await page.setViewportSize({ width: 390, height: 700 });
  await page.clock.runFor(50);
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
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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
  await prepareLocalPage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(0);
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
  await expect(page.locator("#explore-cta a")).toBeVisible();
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

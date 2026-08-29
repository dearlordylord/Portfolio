import { expect, test, type Page } from "@playwright/test";
import { MOBILE_HERO_CONTRACT } from "../../src/motion/hero-contract";

type HeroRuntime = {
  scenes: {
    hero: {
      phase: string;
      targetFrame: number;
      assets: { introReady: boolean };
      canvas: {
        cssWidth: number;
        cssHeight: number;
        renderedAsset: {
          key: string;
          source: string;
          destination: { x: number; y: number; width: number; height: number };
          naturalWidth: number;
          naturalHeight: number;
        } | null;
      };
    };
  };
};

async function prepareLocalPage(page: Page): Promise<void> {
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
}

async function installPausedClock(page: Page): Promise<void> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
}

async function heroRuntime(page: Page): Promise<HeroRuntime> {
  return page.evaluate(() => {
    const diagnostics = (window as typeof window & {
      __portfolioMotion?: { snapshot(): HeroRuntime };
    }).__portfolioMotion;
    if (!diagnostics) throw new Error("motion diagnostics unavailable");
    return diagnostics.snapshot();
  });
}

async function renderedAssetObservation(page: Page): Promise<{
  ratio: number;
  clipped: boolean;
  content: { left: number; top: number; right: number; bottom: number };
  canvas: { width: number; height: number };
  destination: { x: number; y: number; width: number; height: number };
  source: string;
}> {
  const state = await heroRuntime(page);
  const asset = state.scenes.hero.canvas.renderedAsset;
  if (!asset) throw new Error("hero did not render an image asset");
  const alpha = await page.evaluate(async ({ source }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const raster = document.createElement("canvas");
    raster.width = Math.max(1, Math.round(image.naturalWidth * scale));
    raster.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = raster.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("alpha inspection context unavailable");
    context.drawImage(image, 0, 0, raster.width, raster.height);
    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    let left = raster.width;
    let top = raster.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        if ((pixels[(y * raster.width + x) * 4 + 3] ?? 0) <= 8) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    raster.width = 0;
    raster.height = 0;
    return bottom >= top && right >= left
      ? {
          left: left / scale,
          top: top / scale,
          right: (right + 1) / scale,
          bottom: (bottom + 1) / scale,
        }
      : null;
  }, { source: asset.source });
  if (alpha === null) throw new Error("hero asset has no nontransparent content");
  const scaleX = asset.destination.width / asset.naturalWidth;
  const scaleY = asset.destination.height / asset.naturalHeight;
  const contentLeft = asset.destination.x + alpha.left * scaleX;
  const contentRight = asset.destination.x + alpha.right * scaleX;
  const contentTop = asset.destination.y + alpha.top * scaleY;
  const contentBottom = asset.destination.y + alpha.bottom * scaleY;
  return {
    ratio: ((alpha.bottom - alpha.top) * scaleY) / state.scenes.hero.canvas.cssHeight,
    clipped:
      contentLeft < -0.5 ||
      contentTop < -0.5 ||
      contentRight > state.scenes.hero.canvas.cssWidth + 0.5 ||
      contentBottom > state.scenes.hero.canvas.cssHeight + 0.5,
    content: { left: contentLeft, top: contentTop, right: contentRight, bottom: contentBottom },
    canvas: {
      width: state.scenes.hero.canvas.cssWidth,
      height: state.scenes.hero.canvas.cssHeight,
    },
    destination: asset.destination,
    source: asset.source,
  };
}

test("N4 About surface has no rounded edges", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "N4 is checked at the mobile layout seam");
  await prepareLocalPage(page);
  await page.goto("/?motionDisable=hero,particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });

  const radii = await page.locator("#about").evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ];
  });
  expect(radii).toEqual(["0px", "0px", "0px", "0px"]);
});

test("N5 every Journey row keeps a 16px gap on both sides of the spine", async ({ page }) => {
  await prepareLocalPage(page);
  await page.goto("/?motionDisable=hero,particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });

  const gaps = await page.locator("#timeline").evaluate((timeline) => {
    const spine = timeline.querySelector<HTMLElement>(".tl-spine");
    if (!spine) throw new Error("Journey spine is missing");
    const spineBox = spine.getBoundingClientRect();
    return Array.from(timeline.querySelectorAll<HTMLElement>(".tl-row")).map((row, index) => {
      const year = row.querySelector<HTMLElement>(".tl-yr");
      const text = row.querySelector<HTMLElement>(".tl-body > *");
      if (!year || !text) throw new Error(`Journey row ${index} is missing readable anchors`);
      const yearBox = year.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      return {
        index,
        dateToSpine: spineBox.left - yearBox.right,
        spineToText: textBox.left - spineBox.right,
      };
    });
  });

  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) {
    expect(gap.dateToSpine, `date-to-spine row ${gap.index}`).toBeGreaterThanOrEqual(15);
    expect(gap.dateToSpine, `date-to-spine row ${gap.index}`).toBeLessThanOrEqual(17);
    expect(gap.spineToText, `spine-to-text row ${gap.index}`).toBeGreaterThanOrEqual(15);
    expect(gap.spineToText, `spine-to-text row ${gap.index}`).toBeLessThanOrEqual(17);
  }
});

test("N3 keeps both mobile copy groups in one slot 24px below the former anchor", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "N3 is checked at the mobile layout seam");
  await prepareLocalPage(page);
  await page.goto("/?motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });

  const geometry = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const role = document.querySelector<HTMLElement>("#st1")?.getBoundingClientRect();
    const experience = document.querySelector<HTMLElement>("#st2")?.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>("#scrolly-canvas")?.getBoundingClientRect();
    return {
      copyTop: Number.parseFloat(root.getPropertyValue("--hero-copy-top")),
      viewportHeight: innerHeight,
      roleTop: role?.top ?? Number.NaN,
      experienceTop: experience?.top ?? Number.NaN,
      stageTop: stage?.top ?? Number.NaN,
      roleBottom: role?.bottom ?? Number.NaN,
      experienceBottom: experience?.bottom ?? Number.NaN,
    };
  });

  expect(geometry.copyTop).toBeCloseTo(geometry.viewportHeight * 0.09 + 24, 1);
  expect(geometry.roleTop).toBeCloseTo(geometry.experienceTop, 1);
  expect(geometry.roleBottom).toBeLessThanOrEqual(geometry.stageTop);
  expect(geometry.experienceBottom).toBeLessThanOrEqual(geometry.stageTop);
});

test("N3 keeps the larger experience group above the stage on a short mobile viewport", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "N3 is checked at the mobile layout seam");
  await prepareLocalPage(page);
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/?motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });

  const geometry = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const role = document.querySelector<HTMLElement>("#st1")?.getBoundingClientRect();
    const experience = document.querySelector<HTMLElement>("#st2")?.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>("#scrolly-canvas")?.getBoundingClientRect();
    return {
      copyTop: Number.parseFloat(root.getPropertyValue("--hero-copy-top")),
      viewportHeight: innerHeight,
      roleTop: role?.top ?? Number.NaN,
      experienceTop: experience?.top ?? Number.NaN,
      stageTop: stage?.top ?? Number.NaN,
      roleBottom: role?.bottom ?? Number.NaN,
      experienceBottom: experience?.bottom ?? Number.NaN,
    };
  });

  const formerTop = geometry.viewportHeight * 0.09;
  const requestedTop = formerTop + 24;
  expect(geometry.copyTop, JSON.stringify(geometry)).toBeGreaterThan(formerTop);
  expect(geometry.copyTop, JSON.stringify(geometry)).toBeLessThan(requestedTop);
  expect(geometry.experienceBottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.stageTop);
});

test("N2 renders the transparent hero content 40% larger than the mobile baseline", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "N2 is checked at the mobile layout seam");
  test.slow();
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect.poll(async () => (await heroRuntime(page)).scenes.hero.assets.introReady, { timeout: 20_000 }).toBe(true);
  await page.clock.runFor(1_600);

  // Frame 030/031 is the stable ready checkpoint. Its measured alpha>8 bounds
  // are 489/507 of the source height; the former renderer fitted that source at
  // 0.55. This independently recorded baseline keeps the acceptance check
  // about rendered content, not the implementation's new scale token.
  const baselineRatio = (489 / 507) * 0.55;
  const assertNoClipping = async (checkpoint: string, width: number): Promise<void> => {
    const pageWidth = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(pageWidth.scrollWidth, `page overflow at ${width}px`).toBe(pageWidth.clientWidth);
    const observation = await renderedAssetObservation(page);
    expect(observation.clipped, JSON.stringify({ width, checkpoint, ...observation })).toBe(false);
  };
  const settleTerminalAsset = async (width: number): Promise<{ state: HeroRuntime; elapsedMs: number }> => {
    const stepMs = 100;
    const maxMs = 1_500;
    let elapsedMs = 0;
    while (true) {
      const state = await heroRuntime(page);
      if (state.scenes.hero.canvas.renderedAsset?.key === "frame-149") {
        return { state, elapsedMs };
      }
      if (elapsedMs >= maxMs) {
        throw new Error(
          `terminal asset did not converge at ${width}px within ${maxMs}ms: ${JSON.stringify(state.scenes.hero)}`,
        );
      }
      await page.clock.runFor(stepMs);
      elapsedMs += stepMs;
    }
  };

  const early390 = await heroRuntime(page);
  expect(early390.scenes.hero.phase, "early phase at 390px").toBe("ready");
  expect(early390.scenes.hero.targetFrame, "early frame at 390px").toBe(31);
  const earlyObservation390 = await renderedAssetObservation(page);
  expect(earlyObservation390.ratio, "rendered ratio at early/390px").toBeGreaterThanOrEqual(baselineRatio * 1.35);
  expect(earlyObservation390.ratio, "rendered ratio at early/390px").toBeLessThanOrEqual(baselineRatio * 1.45);
  await assertNoClipping("early", 390);

  await page.setViewportSize({ width: 360, height: 844 });
  await page.clock.runFor(16);
  const early360 = await heroRuntime(page);
  expect(early360.scenes.hero.phase, "early phase at 360px").toBe("ready");
  expect(early360.scenes.hero.targetFrame, "early frame at 360px").toBe(31);
  await assertNoClipping("early", 360);

  // The paused clock makes the midpoint and terminal source selection
  // deterministic: 1750ms is exactly half of the 3500ms playback contract.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(16);
  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, 160);
  await page.clock.runFor(1_750);
  const mid390 = await heroRuntime(page);
  expect(mid390.scenes.hero.phase, "mid phase at 390px").toBe("playing");
  expect(mid390.scenes.hero.targetFrame, "mid frame at 390px").toBeGreaterThanOrEqual(89);
  expect(mid390.scenes.hero.targetFrame, "mid frame at 390px").toBeLessThanOrEqual(92);
  await assertNoClipping("mid", 390);

  await page.setViewportSize({ width: 360, height: 844 });
  await page.clock.runFor(16);
  const mid360 = await heroRuntime(page);
  expect(mid360.scenes.hero.phase, "mid phase at 360px").toBe("playing");
  expect(mid360.scenes.hero.targetFrame, "mid frame at 360px").toBeGreaterThanOrEqual(89);
  expect(mid360.scenes.hero.targetFrame, "mid frame at 360px").toBeLessThanOrEqual(92);
  await assertNoClipping("mid", 360);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(195, 843);
  await page.clock.runFor(1_750);
  // Completion latches targetFrame immediately, while displayFrame still
  // converges through the renderer's frame smoothing. Advance in fixed
  // paused-clock steps until the rendered asset itself reaches frame 149.
  const terminal390Settlement = await settleTerminalAsset(390);
  const terminal390 = terminal390Settlement.state;
  expect(terminal390.scenes.hero.phase, "terminal phase at 390px").toBe("complete");
  expect(terminal390.scenes.hero.targetFrame, "terminal frame at 390px").toBeGreaterThanOrEqual(148.5);
  expect(terminal390.scenes.hero.canvas.renderedAsset?.key, "terminal asset at 390px").toBe("frame-149");
  await assertNoClipping("terminal", 390);

  await page.setViewportSize({ width: 360, height: 844 });
  await page.mouse.move(180, 843);
  await page.clock.runFor(16);
  const terminal360Settlement = await settleTerminalAsset(360);
  const terminal360 = terminal360Settlement.state;
  expect(terminal360.scenes.hero.phase, "terminal phase at 360px").toBe("complete");
  expect(terminal360.scenes.hero.targetFrame, "terminal frame at 360px").toBeGreaterThanOrEqual(148.5);
  expect(terminal360.scenes.hero.canvas.renderedAsset?.key, "terminal asset at 360px").toBe("frame-149");
  await assertNoClipping("terminal", 360);
});

test("N1 holds trusted mobile wheel scrolling until the 14+ handoff, then releases the next gesture", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "N1 is checked at the mobile layout seam");
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });
  await page.mouse.move(195, 500);
  await page.evaluate(() => {
    (window as typeof window & {
      __n1WheelSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
    }).__n1WheelSamples = [];
    window.addEventListener("wheel", (event) => {
      (window as typeof window & {
        __n1WheelSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
      }).__n1WheelSamples?.push({
        trusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });

  // A gesture arriving while assets/intro are settling is consumed too; the
  // first screen cannot be released by a race with image readiness.
  await page.mouse.wheel(0, 160);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(async () => (await heroRuntime(page)).scenes.hero.assets.introReady, {
    timeout: 20_000,
  }).toBe(true);
  await page.clock.runFor(1_600);
  expect((await heroRuntime(page)).scenes.hero).toMatchObject({
    phase: "ready",
  });

  await page.mouse.wheel(0, 160);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  expect((await heroRuntime(page)).scenes.hero).toMatchObject({ phase: "playing" });
  await page.clock.runFor(1_400);
  const beforeHandoff = await heroRuntime(page);
  expect(beforeHandoff.scenes.hero.targetFrame).toBeGreaterThanOrEqual(
    MOBILE_HERO_CONTRACT.experience.fadeIn,
  );

  await page.mouse.wheel(0, 160);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const wheelSamples = await page.evaluate(() =>
    (window as typeof window & {
      __n1WheelSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
    }).__n1WheelSamples ?? [],
  );
  expect(wheelSamples.length).toBeGreaterThanOrEqual(3);
  expect(wheelSamples.slice(0, 2)).toEqual([
    { trusted: true, defaultPrevented: true },
    { trusted: true, defaultPrevented: true },
  ]);
  expect(wheelSamples.at(-1)).toEqual({ trusted: true, defaultPrevented: false });

  const afterHandoff = await heroRuntime(page);
  await page.clock.runFor(200);
  const progressed = await heroRuntime(page);
  expect(progressed.scenes.hero.targetFrame).toBeGreaterThanOrEqual(
    afterHandoff.scenes.hero.targetFrame,
  );
});

test("N1 holds trusted mobile touch scrolling until the 14+ handoff, then releases the next gesture", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("chromium-mobile"), "Trusted touch driver is Chromium CDP");
  test.slow();
  await prepareLocalPage(page);
  await installPausedClock(page);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect.poll(async () => (await heroRuntime(page)).scenes.hero.assets.introReady, {
    timeout: 20_000,
  }).toBe(true);
  await page.clock.runFor(1_600);
  await page.evaluate(() => {
    (window as typeof window & {
      __n1TouchSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
    }).__n1TouchSamples = [];
    window.addEventListener("touchmove", (event) => {
      (window as typeof window & {
        __n1TouchSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
      }).__n1TouchSamples?.push({
        trusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (): Promise<void> => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 195, y: 600 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 195, y: 500 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };

  await swipe();
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
  expect((await heroRuntime(page)).scenes.hero.phase).toBe("playing");
  const earlyTouch = await page.evaluate(() =>
    (window as typeof window & {
      __n1TouchSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
    }).__n1TouchSamples ?? [],
  );
  expect(earlyTouch).toEqual([{ trusted: true, defaultPrevented: true }]);

  await page.clock.runFor(1_400);
  expect((await heroRuntime(page)).scenes.hero.targetFrame).toBeGreaterThanOrEqual(
    MOBILE_HERO_CONTRACT.experience.fadeIn,
  );
  await swipe();
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const touchSamples = await page.evaluate(() =>
    (window as typeof window & {
      __n1TouchSamples?: Array<{ trusted: boolean; defaultPrevented: boolean }>;
    }).__n1TouchSamples ?? [],
  );
  expect(touchSamples).toEqual([
    { trusted: true, defaultPrevented: true },
    { trusted: true, defaultPrevented: false },
  ]);
});

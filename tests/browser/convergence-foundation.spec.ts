import { expect, test, type Page } from "@playwright/test";
import { HERO_CONTRACT } from "../../src/motion/hero-contract";
import {
  characterizeTemporalTrace,
  type TemporalInput,
  type TemporalSample,
  type TemporalTrace,
  type ObservedRect,
  type SpatialObservation,
} from "../../src/motion/convergence-observation";
import type { BrowserVisualProbeObservation } from "../../src/browser/visual-inspection";

type Runtime = {
  capturedAt: number;
  scroll: { x: number; y: number };
  viewport: { visual: { width: number; height: number; offsetTop: number; offsetLeft: number } | null };
  scenes: {
    hero: {
      phase: string;
      playbackCompleted: boolean;
      targetFrame: number;
      displayFrame: number;
      renderedFrame: number;
      assets: { introReady: boolean };
      canvas: {
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

async function runtime(page: Page): Promise<Runtime> {
  return page.evaluate(() => {
    const port = (window as Window & { __portfolioMotion?: { snapshot(): Runtime } }).__portfolioMotion;
    if (!port) throw new Error("motion diagnostics unavailable");
    return port.snapshot();
  });
}

async function renderedContentObservation(
  page: Page,
  base: SpatialObservation,
): Promise<SpatialObservation> {
  const state = await runtime(page);
  const asset = state.scenes.hero.canvas.renderedAsset;
  const canvas = base.anchors.heroHead?.rect;
  const stage = base.anchors.heroStage?.rect;
  if (!asset || !canvas || !stage) return base;
  const alpha = await page.evaluate(async ({ source }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    // A 512px inspection raster resolves sub-CSS-pixel edges after the image
    // is fitted into a mobile canvas, while avoiding a multi-megabyte alpha
    // buffer that can distort the browser suite following this test.
    const inspectionScale = Math.min(
      1,
      512 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    canvas.width = Math.max(1, Math.round(image.naturalWidth * inspectionScale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * inspectionScale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2d context unavailable for alpha-bound measurement");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width;
    let top = canvas.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if ((pixels[(y * canvas.width + x) * 4 + 3] ?? 0) <= 8) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    const toNaturalX = image.naturalWidth / canvas.width;
    const toNaturalY = image.naturalHeight / canvas.height;
    const result = right >= left && bottom >= top
      ? {
          left: left * toNaturalX,
          top: top * toNaturalY,
          right: (right + 1) * toNaturalX,
          bottom: (bottom + 1) * toNaturalY,
          width: (right - left + 1) * toNaturalX,
          height: (bottom - top + 1) * toNaturalY,
        }
      : null;
    canvas.width = 0;
    canvas.height = 0;
    return result;
  }, { source: asset.source });
  if (!alpha) return base;
  const scaleX = asset.destination.width / asset.naturalWidth;
  const scaleY = asset.destination.height / asset.naturalHeight;
  const content: ObservedRect = {
    left: canvas.left + asset.destination.x + alpha.left * scaleX,
    top: canvas.top + asset.destination.y + alpha.top * scaleY,
    right: canvas.left + asset.destination.x + alpha.right * scaleX,
    bottom: canvas.top + asset.destination.y + alpha.bottom * scaleY,
    width: alpha.width * scaleX,
    height: alpha.height * scaleY,
  };
  return {
    anchors: {
      ...base.anchors,
      heroRenderedContent: {
        id: "heroRenderedContent",
        selector: `canvas asset ${asset.key} alpha>8`,
        present: true,
        rect: content,
        viewportIntersectionRatio: (() => {
          const left = Math.max(stage.left, content.left);
          const top = Math.max(stage.top, content.top);
          const right = Math.min(stage.right, content.right);
          const bottom = Math.min(stage.bottom, content.bottom);
          return Math.max(0, right - left) * Math.max(0, bottom - top) / (content.width * content.height);
        })(),
        ancestorClipped:
          content.left < canvas.left ||
          content.top < canvas.top ||
          content.right > canvas.right ||
          content.bottom > canvas.bottom,
        style: null,
      },
    },
    relations: [
      ...base.relations,
      {
        id: "hero-rendered-content-to-stage-height",
        kind: "height-ratio",
        from: "heroRenderedContent",
        to: "heroStage",
        value: content.height / stage.height,
        unit: "ratio",
      },
    ],
  };
}

async function temporalSample(page: Page, step: number): Promise<TemporalSample> {
  const state = await runtime(page);
  const input = await page.evaluate(() => {
    const target = window as Window & { __convergenceLastInput?: TemporalInput };
    const observed = target.__convergenceLastInput ?? null;
    delete target.__convergenceLastInput;
    return observed;
  });
  const visual = state.viewport.visual ?? {
    width: await page.evaluate(() => innerWidth),
    height: await page.evaluate(() => innerHeight),
    offsetTop: 0,
    offsetLeft: 0,
  };
  return {
    step,
    elapsedMs: state.capturedAt,
    input,
    hero: {
      phase: state.scenes.hero.phase,
      playbackCompleted: state.scenes.hero.playbackCompleted,
      targetFrame: state.scenes.hero.targetFrame,
      displayFrame: state.scenes.hero.displayFrame,
      renderedFrame: state.scenes.hero.renderedFrame,
      progress: Math.max(0, Math.min(1, state.scenes.hero.targetFrame / HERO_CONTRACT.endFrame)),
    },
    document: {
      scrollX: state.scroll.x,
      scrollY: state.scroll.y,
      programmaticScrollCalls: await page.evaluate(
        () => (window as Window & { __convergenceProgrammaticScrollCalls?: number }).__convergenceProgrammaticScrollCalls ?? 0,
      ),
    },
    visualViewport: visual,
  };
}

test("records trusted input, motion time, document displacement, and semantic space", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile convergence foundation");
  await page.addInitScript(() => {
    const originalScrollTo = window.scrollTo.bind(window);
    (window as Window & { __convergenceProgrammaticScrollCalls?: number }).__convergenceProgrammaticScrollCalls = 0;
    window.scrollTo = ((...args: Parameters<Window["scrollTo"]>) => {
      const target = window as Window & { __convergenceProgrammaticScrollCalls?: number };
      target.__convergenceProgrammaticScrollCalls = (target.__convergenceProgrammaticScrollCalls ?? 0) + 1;
      return originalScrollTo(...args);
    }) as Window["scrollTo"];
    let touchStartY: number | null = null;
    window.addEventListener("touchstart", (event) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    }, { capture: true });
    window.addEventListener("touchmove", (event) => {
      const currentY = event.touches[0]?.clientY ?? touchStartY ?? 0;
      queueMicrotask(() => {
        (window as Window & { __convergenceLastInput?: TemporalInput }).__convergenceLastInput = {
          kind: "touch",
          trusted: event.isTrusted,
          deltaY: (touchStartY ?? currentY) - currentY,
          defaultPrevented: event.defaultPrevented,
        };
      });
    }, { capture: true });
    window.addEventListener(
      "wheel",
      (event) => {
        queueMicrotask(() => {
          (window as Window & { __convergenceLastInput?: TemporalInput }).__convergenceLastInput = {
            kind: "wheel",
            trusted: event.isTrusted,
            deltaY: event.deltaY,
            defaultPrevented: event.defaultPrevented,
          };
        });
      },
      { capture: true },
    );
  });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await page.goto("/?motionDiagnostics=1&motionDisable=particles,skills,timeline,contact", {
    waitUntil: "domcontentloaded",
  });
  await expect.poll(async () => (await runtime(page)).scenes.hero.assets.introReady).toBe(true);
  await page.clock.runFor(1_600);

  // Capture layout at its named ready checkpoint, before intentional scroll
  // leakage can move the hero or timeline relative to the viewport.
  const baseSpatial = await page.evaluate(() => {
    const probe = (window as Window & { __portfolioVisualProbe?: () => BrowserVisualProbeObservation }).__portfolioVisualProbe;
    if (!probe) throw new Error("visual probe unavailable");
    return probe().spatial;
  });
  const spatial = await renderedContentObservation(page, baseSpatial);

  const samples: TemporalSample[] = [await temporalSample(page, 0)];
  // Repeated trusted inputs make early leakage and the eventual handoff
  // observable. This is a characterization trace: current behavior may never
  // reach the handoff because early native scrolling can deactivate the hero.
  for (let step = 1; step <= 24; step += 1) {
    await page.mouse.wheel(0, 160);
    await page.clock.runFor(200);
    samples.push(await temporalSample(page, step));
  }
  const trace: TemporalTrace = { clock: "playwright-paused", samples };
  const characterization = characterizeTemporalTrace(trace);
  expect(characterization.valid).toBe(true);
  expect(characterization.firstTrustedInputStep).not.toBeNull();
  expect(
    samples.slice(1).every(
      (sample) => sample.input?.kind === "wheel" && sample.input.trusted,
    ),
  ).toBe(true);
  expect(characterization.firstProgressStep).not.toBeNull();

  expect(spatial.anchors.heroHead?.present).toBe(true);
  expect(spatial.anchors.aboutSurface?.style).not.toBeNull();
  for (const anchor of Object.values(spatial.anchors)) {
    expect(anchor.present, `${anchor.id} is missing`).toBe(true);
    expect(anchor.rect, `${anchor.id} has no rendered box`).not.toBeNull();
    expect(
      Object.values(anchor.rect ?? {}).every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
      `${anchor.id} has non-finite geometry`,
    ).toBe(true);
    expect(Number.isFinite(anchor.viewportIntersectionRatio)).toBe(true);
    expect(typeof anchor.ancestorClipped).toBe("boolean");
  }
  expect(
    spatial.relations.every(
      (relation) => relation.value !== null && Number.isFinite(relation.value),
    ),
    "every spatial relationship must produce a finite measurement",
  ).toBe(true);
  const aboutStyle = spatial.anchors.aboutSurface!.style!;
  expect([
    aboutStyle.borderTopLeftRadius,
    aboutStyle.borderTopRightRadius,
    aboutStyle.borderBottomRightRadius,
    aboutStyle.borderBottomLeftRadius,
  ].every((radius) => Number.isFinite(Number.parseFloat(radius)))).toBe(true);
  const relationIds = spatial.relations.map((relation) => relation.id);
  expect(relationIds.slice(0, 3)).toEqual([
    "hero-head-to-stage-height",
    "role-copy-top-from-stage",
    "experience-copy-top-from-stage",
  ]);
  const journeyRows = await page.locator("#timeline .tl-row").count();
  for (let index = 0; index < journeyRows; index += 1) {
    expect(relationIds).toContain(`journey-row-${index}-year-to-spine`);
    expect(relationIds).toContain(`journey-row-${index}-spine-to-body`);
  }
  expect(relationIds).toContain("hero-rendered-content-to-stage-height");

  let touchTrace: TemporalTrace | null = null;
  if (testInfo.project.name.startsWith("chromium")) {
    // Chromium's input domain produces browser-trusted touch movement; DOM
    // constructors cannot validate the mobile touch path. Reloading isolates
    // this trace from the wheel trace's intentional scroll leakage.
    await page.goto("/?motionDiagnostics=1&motionDisable=particles,skills,timeline,contact", {
      waitUntil: "domcontentloaded",
    });
    await expect.poll(async () => (await runtime(page)).scenes.hero.assets.introReady).toBe(true);
    await page.clock.runFor(1_600);
    const touchSamples: TemporalSample[] = [await temporalSample(page, 0)];
    const cdp = await page.context().newCDPSession(page);
    for (let step = 1; step <= 4; step += 1) {
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
      await page.clock.runFor(200);
      touchSamples.push(await temporalSample(page, step));
    }
    touchTrace = { clock: "playwright-paused", samples: touchSamples };
    const touchCharacterization = characterizeTemporalTrace(touchTrace);
    expect(touchCharacterization.valid).toBe(true);
    expect(touchCharacterization.firstTrustedInputStep).not.toBeNull();
    expect(
      touchSamples.slice(1).every(
        (sample) => sample.input?.kind === "touch" && sample.input.trusted,
      ),
    ).toBe(true);
  }

  await testInfo.attach("convergence-foundation.json", {
    body: Buffer.from(JSON.stringify({ trace, characterization, touchTrace, spatial }, null, 2)),
    contentType: "application/json",
  });
});

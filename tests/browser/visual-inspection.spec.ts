import { expect, test, type Page } from "@playwright/test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  HERO_CONTRACT,
  MOBILE_HERO_CONTRACT,
  sampleHeroTimeline,
} from "../../src/motion/hero-contract";
import {
  BACKGROUND_SAMPLE_REGIONS,
  BACKGROUND_SAMPLE_POINTS,
  BACKGROUND_SAMPLE_TOPOLOGY,
  evaluateVisualConvergence,
  type BackgroundSampleSet,
  type HeroCopySnapshot,
  type HeroPersistenceSample,
  type InspectionCheckpoint,
  type VisualScenarioObservation,
} from "../../src/motion/visual-inspection";
import {
  type BrowserVisualProbeObservation,
  type VisualBackgroundSample,
  type VisualElementEvidence,
} from "../../src/browser/visual-inspection";

type RuntimeSnapshot = {
  capturedAt: number;
  scenes: {
    hero: {
      phase: string;
      targetFrame: number;
      displayFrame: number;
      renderedFrame: number;
      overlays: { experienceOpacity: number };
      assets: { introReady: boolean };
    };
    visual: BrowserVisualProbeObservation;
  };
};

type InspectionManifest = {
  schemaVersion: 2;
  runId: string;
  createdAt: string;
  completed: boolean;
  completedAt?: string;
  commit: string;
  dirty: boolean;
  diffHash: string;
  project: string;
  browser: { name: string; version: string };
  url: string;
  viewport: { width: number; height: number; dpr: number };
  config: {
    query: string;
    checkpoints: readonly InspectionCheckpoint[];
    clock: "paused";
    fonts: "production";
    cssAnimations: "fast-forwarded-at-capture";
  };
  fonts?: readonly {
    family: string;
    status: string;
    weight: string;
    style: string;
  }[];
};

const enabled = process.env.MOTION_INSPECTION === "1";
const checkpointOrder: readonly InspectionCheckpoint[] = [
  "hero-role",
  "hero-experience",
  "hero-terminal",
  "below-hero",
  "timeline",
  "hero-return",
];
const frameMs = 1000 / 60;
const experienceSeekMs = (() => {
  for (
    let elapsed = 0;
    elapsed <= HERO_CONTRACT.playbackDurationMs;
    elapsed += 10
  ) {
    if (
      sampleHeroTimeline("playing", elapsed).targetFrame >=
      MOBILE_HERO_CONTRACT.experience.peak
    )
      return elapsed;
  }
  throw new Error("Hero contract has no experience checkpoint");
})();
const neutralTerminalFrame = HERO_CONTRACT.endFrame - HERO_CONTRACT.driftFrames;
const runId = (
  process.env.MOTION_INSPECTION_RUN_ID ?? `${Date.now()}-${randomUUID()}`
).replace(/[^a-zA-Z0-9_.-]/g, "-");
const runsRoot = path.resolve("motion-artifacts", "inspection-runs");
const stagingDirectory = path.join(runsRoot, `.mobile-390x844-${runId}.tmp`);
const promotedDirectory = path.join(runsRoot, `mobile-390x844-${runId}`);
const currentDirectory = path.resolve(
  "motion-artifacts",
  "inspection-current",
  "mobile-390x844",
);
const scenarioId = "mobile-390x844-primary";

function gitOutput(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function workspaceProvenance(): Pick<
  InspectionManifest,
  "commit" | "dirty" | "diffHash"
> {
  const status = gitOutput("status", "--porcelain=v1");
  const files = execFileSync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256").update(`${status}\0`);
  files.forEach((relativePath) => {
    const absolutePath = path.resolve(relativePath);
    const stat = lstatSync(absolutePath);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "file"
        : "other";
    const contents = stat.isSymbolicLink()
      ? readlinkSync(absolutePath)
      : stat.isFile()
        ? readFileSync(absolutePath)
        : "";
    digest.update(`${relativePath}\0${kind}\0${stat.mode.toString(8)}\0`);
    digest.update(contents);
    digest.update("\0");
  });
  return {
    commit: gitOutput("rev-parse", "HEAD"),
    dirty: status.length > 0,
    diffHash: digest.digest("hex"),
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function reportHtml(
  observations: readonly VisualScenarioObservation[],
  findings: ReturnType<typeof evaluateVisualConvergence>,
  manifest: InspectionManifest,
): string {
  const cards = observations
    .map(
      (observation) => `<article>
    <img src="${observation.checkpoint}.png" alt="${escapeHtml(observation.checkpoint)} checkpoint">
    <h2>${escapeHtml(observation.checkpoint)}</h2>
    <dl><dt>Phase / frame</dt><dd>${escapeHtml(observation.hero.phase)} / ${observation.hero.displayFrame.toFixed(2)}</dd>
    <dt>14+ computed opacity</dt><dd>${observation.hero.computedExperienceOpacity.toFixed(2)}</dd>
    <dt>Visual viewport insets</dt><dd>${escapeHtml(JSON.stringify(observation.probe.viewport.insets))}</dd>
    <dt>Timeline semantic rows</dt><dd>${observation.probe.insets.timelineSemantic?.rows.length ?? 0}</dd></dl>
  </article>`,
    )
    .join("\n");
  const rows = findings
    .map(
      (finding) =>
        `<tr data-status="${finding.status}"><th>${finding.requirement}</th><td>${finding.status}</td><td>${escapeHtml(finding.metric)}</td><td>${escapeHtml(finding.expected)}</td><td>${escapeHtml(finding.observed)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Motion convergence inspection</title>
  <style>:root{font-family:Inter,system-ui,sans-serif;color:#1c0b2e;background:#edeef6}body{margin:0;padding:32px}h1{font:800 32px Syne,system-ui;margin:0 0 8px}.note{max-width:900px;color:#655d70;margin-bottom:24px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden;margin-bottom:28px}th,td{text-align:left;padding:12px;border-bottom:1px solid #ece9f2;vertical-align:top}tr[data-status=unmet] td:nth-child(2){color:#b0004b;font-weight:800}tr[data-status=met] td:nth-child(2){color:#08763a;font-weight:800}tr[data-status=inconclusive] td:nth-child(2){color:#8a5a00;font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}article{background:#fff;border-radius:16px;padding:12px;box-shadow:0 8px 30px #75658a18}img{display:block;width:100%;height:auto;border-radius:10px;background:#ddd}article h2{font-size:16px}dl{display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px}dt{color:#776e80}dd{margin:0;overflow-wrap:anywhere}</style>
  <h1>Motion convergence inspection</h1><p class="note">Named semantic checkpoints at ${escapeHtml(`${manifest.viewport.width}×${manifest.viewport.height}`)}; commit <code>${escapeHtml(manifest.commit)}</code>${manifest.dirty ? " (dirty working tree)" : ""}. Browser clock is paused and checkpoints are gated by phase, frame, visibility, and scroll-target assertions. This report characterizes behavior; it does not approve a fix.</p>
  <table><thead><tr><th>Req</th><th>Status</th><th>Metric</th><th>Expected</th><th>Observed</th></tr></thead><tbody>${rows}</tbody></table><section class="grid">${cards}</section>`;
}

function promoteRun(): void {
  mkdirSync(path.dirname(currentDirectory), { recursive: true });
  renameSync(stagingDirectory, promotedDirectory);
  const linkTemp = path.join(
    path.dirname(currentDirectory),
    `.mobile-390x844-${runId}.link`,
  );
  symlinkSync(
    path.relative(path.dirname(currentDirectory), promotedDirectory),
    linkTemp,
    "dir",
  );
  const previousDirectory = `${currentDirectory}.previous`;
  const currentStat = lstatSync(currentDirectory, { throwIfNoEntry: false });
  if (currentStat?.isSymbolicLink()) {
    // Prepare the previous pointer before replacing current. Both renames are
    // atomic on the same filesystem, and current never points at a partial
    // run. A symlink rename replaces the old symlink rather than following it.
    const oldTarget = readlinkSync(currentDirectory);
    const previousTemp = path.join(
      path.dirname(currentDirectory),
      `.mobile-390x844-previous-${runId}.link`,
    );
    symlinkSync(oldTarget, previousTemp, "dir");
    const previousStat = lstatSync(previousDirectory, {
      throwIfNoEntry: false,
    });
    if (previousStat && !previousStat.isSymbolicLink())
      rmSync(previousDirectory, { recursive: true, force: true });
    renameSync(previousTemp, previousDirectory);
    renameSync(linkTemp, currentDirectory);
  } else {
    // This branch only handles a legacy directory produced before the symlink
    // promotion protocol. New runs take the atomic branch above.
    if (currentStat) {
      if (existsSync(previousDirectory))
        rmSync(previousDirectory, { recursive: true, force: true });
      renameSync(currentDirectory, previousDirectory);
    }
    renameSync(linkTemp, currentDirectory);
  }
  pruneRuns();
}

function cleanupStaleStaging(): void {
  mkdirSync(runsRoot, { recursive: true });
  for (const entry of readdirSync(runsRoot)) {
    if (entry.startsWith(".mobile-390x844-") && entry.endsWith(".tmp")) {
      rmSync(path.join(runsRoot, entry), { recursive: true, force: true });
    }
  }
  const promotionRoot = path.dirname(currentDirectory);
  if (!existsSync(promotionRoot)) return;
  for (const entry of readdirSync(promotionRoot)) {
    if (entry.startsWith(".mobile-390x844-") && entry.endsWith(".link")) {
      rmSync(path.join(promotionRoot, entry), { recursive: true, force: true });
    }
  }
}

function pointsAt(candidate: string, target: string): boolean {
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return false;
  try {
    return realpathSync(candidate) === realpathSync(target);
  } catch {
    return false;
  }
}

function cleanupFailedRun(): void {
  rmSync(stagingDirectory, { recursive: true, force: true });
  if (!pointsAt(currentDirectory, promotedDirectory) && !pointsAt(`${currentDirectory}.previous`, promotedDirectory)) {
    rmSync(promotedDirectory, { recursive: true, force: true });
  }
  rmSync(path.join(path.dirname(currentDirectory), `.mobile-390x844-${runId}.link`), { recursive: true, force: true });
  rmSync(path.join(path.dirname(currentDirectory), `.mobile-390x844-previous-${runId}.link`), { recursive: true, force: true });
  cleanupStaleStaging();
}

function pruneRuns(): void {
  const keep = new Set<string>();
  for (const candidate of [currentDirectory, `${currentDirectory}.previous`]) {
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) continue;
    try {
      keep.add(path.basename(realpathSync(candidate)));
    } catch {
      // A broken generated pointer is safe to remove below.
    }
  }
  for (const entry of readdirSync(runsRoot)) {
    if (!entry.startsWith("mobile-390x844-") || keep.has(entry)) continue;
    rmSync(path.join(runsRoot, entry), { recursive: true, force: true });
  }
  cleanupStaleStaging();
}

async function runtimeSnapshot(page: Page): Promise<RuntimeSnapshot> {
  return page.evaluate(() => {
    const diagnostics = (
      window as typeof window & {
        __portfolioMotion?: { snapshot(): RuntimeSnapshot };
      }
    ).__portfolioMotion;
    if (!diagnostics) throw new Error("Motion diagnostics are not enabled");
    return diagnostics.snapshot();
  });
}

async function deepVisualProbe(
  page: Page,
): Promise<BrowserVisualProbeObservation> {
  return page.evaluate(() => {
    const capture = (
      window as Window & {
        __portfolioVisualProbe?: () => BrowserVisualProbeObservation;
      }
    ).__portfolioVisualProbe;
    if (!capture) throw new Error("Visual inspection probe is not enabled");
    return capture();
  });
}

async function seekSemantic(
  page: Page,
  name: string,
  durationMs: number,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
): Promise<RuntimeSnapshot> {
  await page.clock.runFor(durationMs);
  const snapshot = await runtimeSnapshot(page);
  if (!predicate(snapshot)) {
    const { phase, targetFrame, displayFrame, renderedFrame } =
      snapshot.scenes.hero;
    throw new Error(
      `Checkpoint '${name}' contract was not met; phase=${phase}, target=${targetFrame}, display=${displayFrame}, rendered=${renderedFrame}`,
    );
  }
  return snapshot;
}

async function alignToVsync(page: Page): Promise<void> {
  const now = await page.evaluate(() => performance.now());
  const remainder = now % frameMs;
  const wait = remainder < 0.05 ? 0 : frameMs - remainder;
  if (wait > 0.05) await page.clock.runFor(wait);
}

async function assertScrollTarget(
  page: Page,
  selector: string,
  previousScrollY: number,
): Promise<void> {
  await page.evaluate((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!target) throw new Error(`Missing scroll target ${targetSelector}`);
    window.scrollTo({
      top: Math.max(0, target.offsetTop - 64),
      behavior: "auto",
    });
  }, selector);
  const state = await page.evaluate((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!target) return null;
    const box = target.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      top: box.top,
      bottom: box.bottom,
      viewportHeight: window.innerHeight,
    };
  }, selector);
  expect(state).not.toBeNull();
  expect(state!.scrollY).toBeGreaterThan(previousScrollY + 16);
  expect(state!.top).toBeGreaterThanOrEqual(-1);
  expect(state!.top).toBeLessThan(state!.viewportHeight);
  expect(state!.bottom).toBeGreaterThan(0);
}

type SamplePoint = (typeof BACKGROUND_SAMPLE_POINTS)[number];

const wholeScreenPoints: readonly SamplePoint[] = BACKGROUND_SAMPLE_POINTS;

async function compositedSamples(
  page: Page,
  screenshot: Buffer,
  points: readonly SamplePoint[] = wholeScreenPoints,
): Promise<{
  samples: VisualBackgroundSample[];
  bitmap: { width: number; height: number };
}> {
  return page.evaluate(
    async ({ source, points }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context)
        return {
          samples: [],
          bitmap: { width: image.naturalWidth, height: image.naturalHeight },
        };
      context.drawImage(image, 0, 0);
      const foreground = [
        "#pcanvas",
        "#about",
        "#scrolly-loader",
        "#st1",
        "#st2",
        "#st-reduced",
        ".st",
        "#noise-top",
        "#explore-cta",
        "#photo-strip",
        "#scroll-hint",
        "nav",
      ];
      const samples = points.map(({ region, x, y }) => {
        const bitmapX = Math.min(
          image.naturalWidth - 1,
          Math.max(0, Math.round(image.naturalWidth * x)),
        );
        const bitmapY = Math.min(
          image.naturalHeight - 1,
          Math.max(0, Math.round(image.naturalHeight * y)),
        );
        const patchWidth = Math.min(36, image.naturalWidth);
        const patchHeight = Math.min(36, image.naturalHeight);
        const patchX = Math.min(
          image.naturalWidth - patchWidth,
          Math.max(0, bitmapX - Math.floor(patchWidth / 2)),
        );
        const patchY = Math.min(
          image.naturalHeight - patchHeight,
          Math.max(0, bitmapY - Math.floor(patchHeight / 2)),
        );
        const cssX = window.innerWidth * x;
        const cssY = window.innerHeight * y;
        const elements = document.elementsFromPoint(cssX, cssY);
        const hitStack = elements.map((element) =>
          element.id ? `#${element.id}` : element.tagName.toLowerCase(),
        );
        const backgroundOnly = !foreground.some((selector) =>
          elements.some(
            (element) =>
              element.matches(selector) || Boolean(element.closest(selector)),
          ),
        );
        const value = context.getImageData(
          patchX,
          patchY,
          patchWidth,
          patchHeight,
        ).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        const count = Math.max(1, value.length / 4);
        for (let index = 0; index < value.length; index += 4) {
          r += value[index] ?? 0;
          g += value[index + 1] ?? 0;
          b += value[index + 2] ?? 0;
          a += value[index + 3] ?? 0;
        }
        return {
          region,
          css: { x: cssX, y: cssY },
          bitmap: { x: bitmapX, y: bitmapY },
          patch: { width: patchWidth, height: patchHeight },
          rgba: {
            r: Math.round(r / count),
            g: Math.round(g / count),
            b: Math.round(b / count),
            a: Math.round(a / count),
          },
          hitStack,
          backgroundOnly,
          reason: backgroundOnly
            ? "no known DOM foreground layer at point"
            : "known DOM foreground layer at point",
        } satisfies VisualBackgroundSample;
      });
      return {
        samples,
        bitmap: { width: image.naturalWidth, height: image.naturalHeight },
      };
    },
    {
      source: `data:image/png;base64,${screenshot.toString("base64")}`,
      points,
    },
  );
}

async function collectStability(
  page: Page,
  initial: VisualElementEvidence,
): Promise<readonly (VisualElementEvidence & { delayMs: number })[]> {
  const samples: (VisualElementEvidence & { delayMs: number })[] = [
    { ...initial, delayMs: 0 },
  ];
  let elapsed = 0;
  for (const delayMs of [500, 2_000]) {
    await page.clock.runFor(delayMs - elapsed);
    elapsed = delayMs;
    const snapshot = await deepVisualProbe(page);
    samples.push({ ...snapshot.heroExperience, delayMs });
  }
  return samples;
}

function copySnapshot(evidence: VisualElementEvidence): HeroCopySnapshot {
  return {
    text: evidence.text,
    display: evidence.display,
    visibility: evidence.visibility,
    opacity: evidence.opacity,
    rect: {
      left: evidence.rect.left,
      top: evidence.rect.top,
      width: evidence.rect.width,
      height: evidence.rect.height,
    },
    viewportIntersection: evidence.viewportIntersection.area > 0,
    unclipped: !evidence.clipped,
    occluded: evidence.occluded,
  };
}

function persistenceSnapshot(
  evidence: VisualElementEvidence & { delayMs: number },
): HeroPersistenceSample {
  return { ...copySnapshot(evidence), delayMs: evidence.delayMs };
}

test.afterEach(async ({}, testInfo) => {
  if (enabled && testInfo.status !== "passed") {
    cleanupFailedRun();
  }
});

test("capture deterministic visual convergence report", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(!enabled, "Run explicitly with npm run inspect:motion");
  test.skip(
    !testInfo.project.name.includes("mobile"),
    "The current report is the mobile contract",
  );
  test.setTimeout(300_000);

  cleanupStaleStaging();
  mkdirSync(stagingDirectory, { recursive: true });
  const provenance = workspaceProvenance();
  const initialManifest: InspectionManifest = {
    schemaVersion: 2,
    runId,
    createdAt: new Date().toISOString(),
    completed: false,
    ...provenance,
    project: testInfo.project.name,
    browser: {
      name: testInfo.project.use.browserName ?? "unknown",
      version: browser.version(),
    },
    url: "",
    viewport: { width: 0, height: 0, dpr: 0 },
    config: {
      query: "?motionDiagnostics=1",
      checkpoints: checkpointOrder,
      clock: "paused",
      fonts: "production",
      cssAnimations: "fast-forwarded-at-capture",
    },
  };
  writeJson(path.join(stagingDirectory, "manifest.json"), initialManifest);

  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await page.goto("/?motionDiagnostics=1", { waitUntil: "domcontentloaded" });
  const fontEvidence = await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.fonts.status !== "loaded")
      throw new Error(
        `Production fonts did not settle: ${document.fonts.status}`,
      );
    const required = [
      { family: "Inter", weight: "400" },
      { family: "Inter", weight: "500" },
      { family: "Inter", weight: "600" },
      { family: "Syne", weight: "700" },
      { family: "Syne", weight: "800" },
    ];
    const evidence = [];
    for (const { family, weight } of required) {
      const face = `${weight} 16px "${family}"`;
      const loadedFaces = await document.fonts.load(face);
      const loaded = loadedFaces.length > 0 && document.fonts.check(face);
      if (!loaded)
        throw new Error(`Required production font did not load: ${face}`);
      evidence.push({ family, status: "loaded", weight, style: "normal" });
    }
    return evidence;
  });
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio || 1,
  }));
  const manifest: InspectionManifest = {
    ...initialManifest,
    url: page.url(),
    viewport,
    fonts: fontEvidence,
  };
  writeJson(path.join(stagingDirectory, "manifest.json"), manifest);
  await expect
    .poll(
      async () => (await runtimeSnapshot(page)).scenes.hero.assets.introReady,
      { timeout: 20_000 },
    )
    .toBe(true);

  const observations: VisualScenarioObservation[] = [];
  const capture = async (
    checkpoint: InspectionCheckpoint,
    stability = false,
  ): Promise<VisualScenarioObservation> => {
    const current = await runtimeSnapshot(page);
    const visual = await deepVisualProbe(page);
    const screenshot = await page.screenshot({
      fullPage: false,
      animations: "disabled",
    });
    const capturesBackground =
      checkpoint === "hero-role" ||
      checkpoint === "hero-experience" ||
      checkpoint === "hero-terminal";
    const composited = capturesBackground
      ? await compositedSamples(page, screenshot)
      : { samples: [], bitmap: { width: 0, height: 0 } };
    const stabilitySamples = stability
      ? await collectStability(page, visual.heroExperience)
      : undefined;
    const probe: BrowserVisualProbeObservation = {
      ...visual,
      surfaces: {
        ...visual.surfaces,
        compositedPixels: composited.samples.map((sample) => sample.rgba),
        compositedBackgroundSamples: composited.samples,
        ...(capturesBackground
          ? {
              backgroundSamples: {
                source: "rendered-first-screen" as const,
                owner: "#scrolly" as const,
                topology: BACKGROUND_SAMPLE_TOPOLOGY,
                regions: BACKGROUND_SAMPLE_REGIONS,
                cssViewport: {
                  width: visual.viewport.layoutWidth,
                  height: visual.viewport.layoutHeight,
                },
                bitmap: composited.bitmap,
                devicePixelRatio:
                  visual.viewport.layoutWidth > 0
                    ? composited.bitmap.width / visual.viewport.layoutWidth
                    : 0,
                expectedCount: BACKGROUND_SAMPLE_POINTS.length,
                texture: "patch-averaged" as const,
                samples: composited.samples.map(
                  ({ reason: _reason, ...sample }) => sample,
                ),
              } satisfies BackgroundSampleSet,
            }
          : {}),
      },
      // Keep the rich browser-only probe on the adapter side. The pure model
      // receives the normalized HeroCopySnapshot below.
    };
    const observation = {
      scenarioId,
      evidence: "synthetic-browser" as const,
      checkpoint,
      probe,
      hero: {
        phase: current.scenes.hero.phase,
        targetFrame: current.scenes.hero.targetFrame,
        displayFrame: current.scenes.hero.displayFrame,
        experienceOpacity: current.scenes.hero.overlays.experienceOpacity,
        computedExperienceOpacity: visual.heroExperience.opacity,
        experience: copySnapshot(visual.heroExperience),
        ...(stabilitySamples
          ? { persistenceSamples: stabilitySamples.map(persistenceSnapshot) }
          : {}),
      },
    } satisfies VisualScenarioObservation;
    observations.push(observation);
    writeFileSync(path.join(stagingDirectory, `${checkpoint}.png`), screenshot);
    return observation;
  };

  await seekSemantic(
    page,
    "hero-role",
    HERO_CONTRACT.introDurationMs + 500,
    (snapshot) =>
      snapshot.scenes.hero.phase === "ready" &&
      Math.abs(snapshot.scenes.hero.targetFrame - HERO_CONTRACT.introEndFrame) <
        0.02 &&
      snapshot.scenes.hero.renderedFrame === HERO_CONTRACT.introEndFrame,
  );
  const roleObservation = await capture("hero-role");
  expect(roleObservation.hero.experience?.text).toContain("14+");

  await alignToVsync(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 100, cancelable: true }),
    ),
  );
  const experience = await seekSemantic(
    page,
    "hero-experience",
    experienceSeekMs,
    (snapshot) =>
      snapshot.scenes.hero.phase === "playing" &&
      snapshot.scenes.hero.targetFrame >=
        MOBILE_HERO_CONTRACT.experience.peak &&
      snapshot.scenes.hero.targetFrame <
        MOBILE_HERO_CONTRACT.experience.fadeOut,
  );
  expect(experience.scenes.hero.targetFrame).toBeGreaterThanOrEqual(
    MOBILE_HERO_CONTRACT.experience.peak,
  );
  await capture("hero-experience");

  await seekSemantic(
    page,
    "hero-terminal",
    HERO_CONTRACT.playbackDurationMs - experienceSeekMs + 500,
    (snapshot) =>
      snapshot.scenes.hero.phase === "complete" &&
      Math.abs(snapshot.scenes.hero.targetFrame - neutralTerminalFrame) <
        0.02 &&
      Math.abs(snapshot.scenes.hero.renderedFrame - neutralTerminalFrame) <= 1,
  );
  await capture("hero-terminal");

  const beforeAbout = observations.at(-1)!.probe.document.scrollY;
  await assertScrollTarget(page, "#about", beforeAbout);
  await capture("below-hero");
  const beforeTimeline = (await deepVisualProbe(page)).document.scrollY;
  await assertScrollTarget(page, "#timeline", beforeTimeline);
  await capture("timeline");

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await capture("hero-return", true);

  expect(observations.map((observation) => observation.checkpoint)).toEqual(
    checkpointOrder,
  );
  const findings = evaluateVisualConvergence(observations);
  // Require the actual composite evidence to be structurally valid. The
  // threshold test determines met/unmet, so this remains a convergence gate
  // after the product background is corrected.
  expect(findings.find((finding) => finding.requirement === "R2")?.status).not.toBe(
    "inconclusive",
  );
  const completedManifest: InspectionManifest = {
    ...manifest,
    completed: true,
    completedAt: new Date().toISOString(),
  };
  writeJson(path.join(stagingDirectory, "observations.json"), observations);
  writeJson(path.join(stagingDirectory, "findings.json"), findings);
  writeJson(path.join(stagingDirectory, "metadata.json"), completedManifest);
  writeFileSync(
    path.join(stagingDirectory, "index.html"),
    reportHtml(observations, findings, completedManifest),
  );
  const manifestNext = path.join(stagingDirectory, "manifest.next.json");
  writeJson(manifestNext, completedManifest);
  renameSync(manifestNext, path.join(stagingDirectory, "manifest.json"));
  writeFileSync(
    path.join(stagingDirectory, "COMPLETED"),
    `${completedManifest.completedAt}\n`,
  );
  promoteRun();
  console.log(`Motion inspection report: ${currentDirectory}`);
  expect(findings.map((finding) => finding.requirement)).toEqual([
    "R1",
    "R2",
    "R3",
    "R4",
  ]);
});

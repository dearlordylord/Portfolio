import { expect, test, type Page } from "@playwright/test";

import { HEVC_PREPARATION_DEADLINE_MS } from "../../src/motion/hevc-alpha";

function frameNumber(value: string | null): number {
  const match = value?.match(/frame\s+(\d+)/);
  return match ? Number(match[1]) : -1;
}

async function scrubAndRelease(page: Page, target: number): Promise<void> {
  await page.locator("#timeline-scrub").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, target);
}

for (const variant of ["a", "c"] as const) {
  test(`${variant.toUpperCase()} autoplays and release resumes independently of presentation`, async ({ page }) => {
    await page.goto(`/prototype-video?variant=${variant}`);

    await expect.poll(async () => frameNumber(await page.locator("#metric-presented").textContent())).toBeGreaterThanOrEqual(5);
    await expect(page.locator("#metric-actual")).toHaveText("playing");

    for (const target of [38, 62, 70, 90, 140]) {
      await scrubAndRelease(page, target);
      await expect.poll(async () => frameNumber(await page.locator("#metric-target-confirmed").textContent())).toBeGreaterThanOrEqual(target);
      await expect.poll(async () => frameNumber(await page.locator("#metric-target-confirmed").textContent())).toBeLessThanOrEqual(target + 2);
      await expect.poll(async () => frameNumber(await page.locator("#metric-post-seek-progress").textContent())).not.toBe(-1);
      await expect(page.locator("#metric-actual")).toHaveText("playing");
      await expect(page.locator("#metric-scrub")).toHaveText("none");
      await expect.poll(async () => Number((await page.locator("#metric-delta").textContent())?.match(/-?\d+/)?.[0] ?? 999)).toBeLessThanOrEqual(2);
    }

    if (variant === "c") {
      const cornerAlpha = await page.locator("#media-stage canvas").evaluate((canvas) => {
        const context = (canvas as HTMLCanvasElement).getContext("2d");
        return context?.getImageData(0, 0, 1, 1).data[3] ?? 255;
      });
      expect(cornerAlpha).toBe(0);
    }
  });
}

test("A initialization failure bypasses B and falls directly to C", async ({ page }) => {
  await page.goto("/prototype-video?variant=a&forceFail=a");

  await expect(page.locator("#metric-active")).toHaveText(/C · WebP sequence/);
  await expect(page.locator("#metric-fallback")).toContainText("injected: forceFail=a");
  await expect(page.locator("#metric-tape")).toContainText("from=a to=c");
  await expect(page.locator("#metric-tape")).not.toContainText("from=a to=b");
  await expect(page.locator("#media-stage canvas")).toBeVisible();
  await expect(page.locator("#media-stage video")).toHaveCount(0);
});

test("A keeps its native source hidden behind a frame-0 poster until alpha proof", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function canPlayType(type: string): CanPlayTypeResult {
      if (type.includes("vp09")) return "probably";
      return nativeCanPlayType.call(this, type);
    };

    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, type: string, options?: unknown): RenderingContext | null {
      const context = (nativeGetContext as (contextId: string, contextOptions?: unknown) => RenderingContext | null).call(this, type, options);
      if (type !== "2d" || this.width !== 2 || this.height !== 2 || !context) return context;
      const twoD = context as CanvasRenderingContext2D;
      const nativeGetImageData = twoD.getImageData.bind(twoD);
      twoD.getImageData = (...args: Parameters<CanvasRenderingContext2D["getImageData"]>) => {
        const image = nativeGetImageData(...args);
        for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
        return image;
      };
      return twoD;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  let releaseMedia: () => void = () => undefined;
  const mediaDelayed = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  await page.route("**/hero-alpha-vp9.webm", async (route) => {
    await mediaDelayed;
    await route.continue();
  });

  await page.goto("/prototype-video?variant=a", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#metric-active")).toHaveText(/A · Native VP9 alpha/);
  await expect(page.locator("#media-stage .hero-render-poster")).toBeVisible();
  await expect(page.locator("#media-stage video")).toHaveClass(/hero-render-source/);
  await expect(page.locator("#media-stage video")).toHaveCSS("visibility", "hidden");

  releaseMedia();
  await expect(page.locator("#metric-active")).toHaveText(/C · WebP sequence/, { timeout: 10_000 });
  await expect(page.locator("#metric-tape")).toContainText("from=a to=c");
  await expect(page.locator("#metric-tape")).not.toContainText("from=a to=b");
  await expect(page.locator("#media-stage canvas")).toBeVisible();
});

test("H hybrid candidate falls back to C before exposing an unavailable HEVC asset", async ({ page }) => {
  await page.goto("/prototype-video?variant=hybrid");

  await expect(page.locator("#metric-requested")).toHaveText(/H · Safari HEVC alpha/);
  await expect(page.locator("#metric-active")).toHaveText(/C · WebP sequence/);
  await expect(page.locator("#metric-hevc-gate")).toHaveText("asset-missing-import-apple-hevc-alpha");
  await expect(page.locator("#metric-fallback")).toContainText("H asset-missing-import-apple-hevc-alpha");
  await expect(page.locator("#media-stage canvas")).toBeVisible();
  await expect(page.locator("#media-stage video")).toHaveCount(0);
});

test("H does not request an imported candidate without a manual asset/device evidence override", async ({ page }) => {
  let requested = false;
  page.on("request", (request) => {
    if (request.resourceType() !== "fetch" && request.resourceType() !== "media") return;
    if (new URL(request.url()).pathname.includes("/hero-hevc-alpha")) requested = true;
  });

  await page.goto("/prototype-video?variant=h&hevcSrc=/video-prototype/hero-hevc-alpha.mov&hevcAssetId=hero-hevc-alpha-v1");
  await expect(page.locator("#metric-active")).toHaveText(/C · WebP sequence/);
  await expect.poll(() => requested).toBe(false);
});

test("manually enabled H shows a frame-0 poster and falls back after stalled preparation", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function canPlayType(type: string): CanPlayTypeResult {
      if (type.includes("hvc1")) return "probably";
      return nativeCanPlayType.call(this, type);
    };
  });
  await page.route("**/hero-hevc-alpha.mov", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HEVC_PREPARATION_DEADLINE_MS + 500));
    await route.abort();
  });

  await page.goto(
    "/prototype-video?variant=h&hevcSrc=/video-prototype/hero-hevc-alpha.mov&hevcAssetId=hero-hevc-alpha-v1&hevcQualified=asset:hero-hevc-alpha-v1%7Cdevice:macos-safari",
  );
  await expect(page.locator("#media-stage .hero-render-poster")).toBeVisible();
  await expect(page.locator("#media-stage canvas")).toHaveCount(0);
  await expect(page.locator("#metric-hevc-prep")).toHaveText(/waiting.*4000 ms/);
  await expect(page.locator("#metric-hevc-prep")).toHaveText(/timed out.*4000 ms/, {
    timeout: HEVC_PREPARATION_DEADLINE_MS + 2_000,
  });
  await expect(page.locator("#metric-active")).toHaveText(/C · WebP sequence/);
  await expect(page.locator("#media-stage canvas")).toBeVisible();
  await expect(page.locator("#media-stage .hero-render-poster")).toHaveCount(0);
});

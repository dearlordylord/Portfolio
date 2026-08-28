import { expect, test, type Page } from "@playwright/test";

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

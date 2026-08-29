import { defineConfig, devices } from "@playwright/test";

/**
 * Draft-only browser coverage for prototype-video.html.
 *
 * This deliberately serves Vite's source tree: production builds omit the
 * architecture-study page, so its tests must never be mixed into the release
 * gate. Keep the spec itself unchanged while the prototype remains useful for
 * future media experiments.
 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/video-prototype.spec.ts",
  timeout: 30_000,
  outputDir: "./test-results/prototype",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/prototype", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Vite dev mode serves prototype-video.html and its source/runtime inputs.
    command: "npm run prototype:serve",
    url: "http://127.0.0.1:4173",
    timeout: 60_000,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-mobile-390x844",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium" as const,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "webkit-mobile-390x844",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit" as const,
        viewport: { width: 390, height: 844 },
      },
      metadata: { requiresSystemWebKitDependencies: true },
    },
    {
      name: "chromium-desktop-1440x900",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ].filter((project) => project.name !== "webkit-mobile-390x844" || process.env.PLAYWRIGHT_WEBKIT === "1"),
});

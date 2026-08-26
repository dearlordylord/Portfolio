import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: process.env.MOTION_INSPECTION === "1" ? 300_000 : 30_000,
  outputDir: "./test-results",
  // The current page runs a 440-particle all-pairs loop. Parallel browser pages
  // distort the very mobile baseline this harness is intended to characterize.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Exercise the deployable output. The dev server can resolve source-root
    // runtime assets that are absent from dist and would hide broken releases.
    command: "npm run build && npm run verify:dist && npm run preview",
    url: "http://127.0.0.1:4173",
    timeout: 180_000,
    // Never accept an unrelated dev server on this port: these tests are the
    // release gate for the exact production build created above.
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
    }
  ].filter((project) => project.name !== "webkit-mobile-390x844" || process.env.PLAYWRIGHT_WEBKIT === "1"),
});

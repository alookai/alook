import { defineConfig, devices } from "@playwright/test"

// Perf-diagnosis config — deliberately separate from playwright.config.ts.
//
// - Matches only `*.perf.ts`, so the CI e2e-ui workflow (which matches
//   `**/*.spec.ts`) never picks these up. This is a LOCAL diagnostic.
// - NO globalSetup/globalTeardown: the e2e global-setup resets the local D1 and
//   registers ephemeral stamped users. The perf run must NOT wipe the DB the
//   stress-seed just populated, and must drive as the STABLE seed identity
//   (loaded from perf-artifacts/seed-manifest.json inside the spec), not a
//   fresh stamped user.
const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"

export default defineConfig({
  testDir: "./src/test/e2e-ui/perf",
  testMatch: "**/*.perf.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  // Generous: each switch pays full dev-build API fan-out + paint + reflow.
  // The spec also flushes its capture incrementally, so even if this cap is hit
  // the report generator still has data to work with.
  timeout: 600_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})

import { defineConfig, devices } from "@playwright/test"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"

export default defineConfig({
  testDir: "./src/test/e2e-ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  globalSetup: "./src/test/e2e-ui/_setup/global-setup.ts",
  globalTeardown: "./src/test/e2e-ui/_setup/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})

import { defineConfig, devices } from "@playwright/test"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"

export default defineConfig({
  testDir: "./src/test/e2e-ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["blob"], ["github"], ["list"]] : "list",
  globalSetup: "./src/test/e2e-ui/_setup/global-setup.ts",
  globalTeardown: "./src/test/e2e-ui/_setup/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
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

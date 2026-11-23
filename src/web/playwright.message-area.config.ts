import { defineConfig, devices } from "@playwright/test"

const BASE_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"
const reuseServer = process.env.ALOOK_VERIFY_REUSE_SERVER === "1"

export default defineConfig({
  testDir: "./src/test/e2e-ui/message-area-verify",
  testMatch: "**/*.verify.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  ...(reuseServer
    ? {}
    : {
        globalSetup: "./src/test/e2e-ui/_setup/global-setup.ts",
        globalTeardown: "./src/test/e2e-ui/_setup/global-teardown.ts",
      }),
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
})

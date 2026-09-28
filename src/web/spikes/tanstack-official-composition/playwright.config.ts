import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "official-composition.spec.ts",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4177",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "pnpm dlx vite@7.1.7 --config spikes/tanstack-official-composition/vite.config.ts --host 127.0.0.1 --port 4177",
    cwd: process.cwd(),
    port: 4177,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})

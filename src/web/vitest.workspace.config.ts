import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "./vitest.config.ts",
      "./vitest.runtime.config.mts",
      "./auth/vitest.config.ts",
      "./auth/vitest.runtime.config.mts",
    ],
  },
})

import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/test/e2e/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
}))

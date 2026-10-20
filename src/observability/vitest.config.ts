import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  test: {
    name: "observability-node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs", "public/**/*.test.js"],
    sequence: { groupOrder: 1 },
  },
}))

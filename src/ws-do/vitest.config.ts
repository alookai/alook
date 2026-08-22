import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  test: {
    name: "ws-do-node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/test-integration/**"],
    sequence: { groupOrder: 1 },
  },
}))

import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  test: {
    name: "email-worker-node",
    include: ["src/**/*.test.ts"],
    sequence: { groupOrder: 1 },
  },
}))

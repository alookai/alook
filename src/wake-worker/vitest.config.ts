import { defineConfig, mergeConfig } from "vitest/config"
import shared from "../../vitest.shared"

export default mergeConfig(shared, defineConfig({
  test: {
    name: "wake-worker-node",
    include: ["src/**/!(*.runtime).test.ts"],
    sequence: { groupOrder: 1 },
  },
}))

import { defineProject } from "vitest/config"

export default defineProject({
  test: {
    name: "ci-scripts",
    environment: "node",
    include: ["**/*.test.ts"],
  },
})

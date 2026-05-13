import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: ["src/shared", "src/web", "src/email-worker", "src/app"],
  },
})

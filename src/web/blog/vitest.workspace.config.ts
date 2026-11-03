import { defineConfig } from "vitest/config"

export default defineConfig({
  root: import.meta.dirname,
  test: {
    projects: [
          "./vitest.config.mts",
          "./vitest.dom.config.mts"
    ],
  },
})

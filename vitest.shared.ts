import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    css: { include: [/\?raw(?:&|$)/] },
    environment: "node",
  },
})

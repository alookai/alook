import { defineConfig } from "vitest/config"

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4177,
    strictPort: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})

import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.attachment-test.toml" },
    }),
  ],
  test: {
    include: ["src/test-integration/**/*.test.ts"],
  },
})

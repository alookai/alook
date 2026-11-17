import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    name: "email-worker-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    sequence: { groupOrder: 11 },
  },
})

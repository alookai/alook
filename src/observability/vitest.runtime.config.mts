import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "migrations"))

export default defineProject({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  })],
  test: {
    name: "observability-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 12 },
  },
})

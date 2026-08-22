import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "../web/migrations"))

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    name: "ws-do-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
    sequence: { groupOrder: 0 },
  },
})

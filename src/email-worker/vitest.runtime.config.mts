import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "../web/migrations"))

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ENCRYPTION_KEY: "runtime-test-encryption-key",
          TEST_MIGRATIONS: migrations,
        },
        serviceBindings: {
          WEB_SERVICE: () => new Response("ok"),
        },
      },
    }),
  ],
  test: {
    name: "email-worker-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 11 },
  },
})

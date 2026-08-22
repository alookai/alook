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
        compatibilityFlags: ["nodejs_compat", "service_binding_extra_handlers"],
        serviceBindings: {
          WS_DO_WORKER: () => Response.json({ delivered: 0 }),
        },
      },
    }),
  ],
  test: {
    name: "wake-worker-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 12 },
  },
})

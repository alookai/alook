import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "migrations"))

export default defineProject({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { TEST_MIGRATIONS: migrations },
      compatibilityFlags: ["nodejs_compat", "service_binding_extra_handlers"],
      workers: [{
        name: "pages-test-application", modules: true, compatibilityDate: "2026-10-19",
        script: `export default {
          async fetch(request) {
            if (request.headers.get("upgrade") === "websocket") {
              const pair = new WebSocketPair()
              pair[1].accept()
              pair[1].addEventListener("close", () => pair[1].close())
              return new Response(null, { status: 101, webSocket: pair[0] })
            }
            return new Response(await request.text(), { headers: { "x-test-application": new URL(request.url).pathname } })
          }
        }`,
      }],
      serviceBindings: { TEST_APPLICATION: "pages-test-application" },
    },
  })],
  test: {
    name: "pages-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 13 },
  },
})

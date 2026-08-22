import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "migrations"))

export default defineProject({
  resolve: {
    alias: {
      "./.open-next/worker.js": path.resolve(
        import.meta.dirname,
        "test-runtime/open-next-worker-stub.ts",
      ),
    },
  },
  plugins: [
    cloudflareTest({
      main: "./custom-worker.ts",
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        assets: {
          binding: "ASSETS",
          directory: path.resolve(import.meta.dirname, "test-runtime/assets"),
        },
        bindings: { TEST_MIGRATIONS: migrations },
        workers: [{
          name: "ws-do-runtime-stub",
          modules: true,
          script: `export default {
            fetch(request) {
              const pair = new WebSocketPair()
              pair[1].accept()
              return new Response(null, {
                status: 101,
                headers: {
                  "x-runtime-pathname": new URL(request.url).pathname,
                  "x-runtime-upgrade": request.headers.get("Upgrade") ?? "",
                },
                webSocket: pair[0],
              })
            },
          }`,
        }],
        serviceBindings: {
          WORKER_SELF_REFERENCE: () => new Response("self"),
          WS_DO_WORKER: "ws-do-runtime-stub",
          EMAIL_WORKER: () => new Response("email"),
          WAKE_WORKER: () => new Response("wake"),
        },
      },
    }),
  ],
  test: {
    name: "web-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 13 },
  },
})

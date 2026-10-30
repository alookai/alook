import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "migrations"))
let providerRequests: { method: string; path: string }[] = []
let redirectedRequests = 0

export default defineProject({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { TEST_MIGRATIONS: migrations },
      compatibilityFlags: ["nodejs_compat", "service_binding_extra_handlers"],
      outboundService: async request => {
        const url = new URL(request.url)
        if (url.hostname === "pages-native-control.invalid") {
          if (request.method === "POST") { providerRequests = []; redirectedRequests = 0 }
          return Response.json({ requests: providerRequests, redirectedRequests })
        }
        if (url.hostname === "redirect-leak.invalid") {
          redirectedRequests++
          return Response.json({ success: true, result: { script: { tags: ["redirected"] } } })
        }
        if (url.hostname !== "api.cloudflare.com") return new Response("uncontrolled network denied", { status: 502 })
        providerRequests.push({ method: request.method, path: url.pathname })
        if (url.pathname.includes("/scripts/native-redirect")) return new Response(null, { status: 302, headers: { location: "https://redirect-leak.invalid/landing" } })
        if (url.pathname.endsWith("/assets-upload-session")) {
          const body = await request.json() as { manifest: Record<string, { hash: string }> }
          return Response.json({ success: true, result: { jwt: "native-session", buckets: [Object.values(body.manifest).map(file => file.hash)] } })
        }
        if (url.pathname.endsWith("/workers/assets/upload")) return Response.json({ success: true, result: { jwt: "native-completion" } }, { status: 201 })
        if (request.method === "GET") return Response.json({ success: true, result: { script: { tags: [] } } })
        if (request.method === "PUT") return Response.json({ success: true, result: { id: "native-roundtrip" } })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        return new Response("unexpected controlled request", { status: 500 })
      },
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

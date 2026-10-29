import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineProject } from "vitest/config"

const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "../web/migrations"))
const wakeRequests: Array<{ path: string; command: unknown }> = []
let failOnce: { agentId: string; seq: number } | undefined

async function wsReceiptStub(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/test/fail-once") {
    failOnce = await request.json() as { agentId: string; seq: number }
    return Response.json({ ok: true })
  }
  if (url.pathname === "/test/wakes") return Response.json(wakeRequests)
  if (url.pathname.endsWith("/forward-agent-wake")) {
    const command = await request.json() as { agentId: string; unreadNotice: { latestSeq: number } }
    wakeRequests.push({ path: url.pathname, command })
    if (command.agentId === failOnce?.agentId && command.unreadNotice.latestSeq === failOnce.seq) {
      failOnce = undefined
      return Response.json({ error: "controlled downstream fault" }, { status: 503 })
    }
    return Response.json({ attempted: 1 })
  }
  return Response.json({ sent: 1 })
}

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        compatibilityFlags: ["nodejs_compat", "service_binding_extra_handlers"],
        serviceBindings: {
          WS_DO_WORKER: wsReceiptStub,
        },
      },
    }),
  ],
  test: {
    name: "queue-worker-runtime",
    include: ["test-runtime/**/*.runtime.test.ts"],
    setupFiles: ["test-runtime/apply-migrations.ts"],
    sequence: { groupOrder: 12 },
  },
})

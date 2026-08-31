import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import {
  E2E_WRANGLER_VERSION,
  hasExactHealth,
  readinessExitMessage,
  resolveE2EWranglerRuntime,
  serviceDefinitions,
  waitForHealth,
  waitForServicesReady,
  wranglerLogEnvironment,
} from "./e2e-ui/_setup/services"
import { resolveMachineWsUrl, resolveWsUrl } from "./e2e-ui/_setup/paths"

describe("UI E2E service definitions", () => {
  it("isolates the exact E2E Wrangler from the normal project CLI", () => {
    const runtime = resolveE2EWranglerRuntime()
    const requireFromTest = createRequire(import.meta.url)
    const normalManifest = requireFromTest("wrangler/package.json") as { version: string }

    expect(runtime.version).toBe(E2E_WRANGLER_VERSION)
    expect(runtime.version).toBe("4.113.0")
    expect(normalManifest.version).toBe("4.125.0")
    expect(runtime.entry).toMatch(/wrangler@4\.113\.0.*bin[/\\]wrangler\.js$/)
  })

  it("runs both Worker zones plus ws-do in CI", () => {
    const definitions = serviceDefinitions(true)

    expect(definitions).toEqual([
      {
        name: "web-zones",
        command: "pnpm",
        args: ["--filter", "@alook/web", "dev:zones:worker"],
        healthUrl: "http://localhost:3000/api/health",
        expectedStatus: 200,
        expectedBody: { status: "ok" },
      },
      {
        name: "ws-do",
        command: "pnpm",
        args: ["--filter", "@alook/ws-do", "dev"],
        healthUrl: "http://localhost:8789/health",
        expectedStatus: 200,
        expectedBody: { status: "ok" },
      },
    ])
  })

  it("keeps the fast two-process topology for local iteration", () => {
    expect(serviceDefinitions(false).map(({ name, command }) => ({ name, command }))).toEqual([
      { name: "web", command: "pnpm" },
      { name: "ws-do", command: "pnpm" },
    ])
  })

  it("uses the web URL for ws-do in the CI single-runtime topology", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      singleRuntime: true,
    })).toBe("http://localhost:3000")
  })

  it("keeps the local ws-do port for the split-runtime topology", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      singleRuntime: false,
    })).toBe("http://localhost:8789")
  })

  it("always honors an explicit ws-do URL", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      explicitWsUrl: "http://localhost:9000",
      singleRuntime: true,
    })).toBe("http://localhost:9000")
  })

  it("routes machine upgrades through the web worker in the single runtime", () => {
    expect(resolveMachineWsUrl({
      wsUrl: "http://localhost:3000/",
      singleRuntime: true,
    })).toBe("http://localhost:3000/api/ws/community-machine")
  })

  it("connects machines directly to ws-do in the split runtime", () => {
    expect(resolveMachineWsUrl({
      wsUrl: "http://localhost:8789/",
      singleRuntime: false,
    })).toBe("http://localhost:8789")
  })

  it.each([
    [200, { status: "ok" }, true],
    [201, { status: "ok" }, false],
    [200, { status: "ok", extra: true }, false],
    [200, { status: "degraded" }, false],
  ] as const)("requires the exact health contract", async (status, body, expected) => {
    const result = await hasExactHealth(
      "http://service.test/health",
      async () => new Response(JSON.stringify(body), { status }),
    )

    expect(result.ok).toBe(expected)
    expect(result.status).toBe(status)
  })

  it("places sanitized debug logs inside the uploaded service-log tree", () => {
    expect(wranglerLogEnvironment("/logs/web-wrangler-internal")).toEqual({
      WRANGLER_LOG: "debug",
      WRANGLER_LOG_PATH: "/logs/web-wrangler-internal",
      WRANGLER_LOG_SANITIZE: "true",
    })
  })

  it("bounds a health probe even when fetch never resolves", async () => {
    const result = await hasExactHealth(
      "http://service.test/health",
      async () => new Promise<Response>(() => {}),
      { timeoutMs: 5 },
    )

    expect(result).toEqual({
      ok: false,
      status: null,
      detail: "health probe timed out after 5ms",
    })
  })

  it("turns a child close before readiness into an immediate failure", () => {
    expect(readinessExitMessage("web-ws-do", null, null)).toBeNull()
    expect(readinessExitMessage("web-ws-do", 1, null))
      .toBe("web-ws-do exited before readiness (code 1, signal null)")
    expect(readinessExitMessage("web-ws-do", null, "SIGTERM"))
      .toBe("web-ws-do exited before readiness (code null, signal SIGTERM)")
  })

  it("races a child close that occurs during an in-flight readiness probe", async () => {
    const proc = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess
    const service = {
      name: "web-ws-do",
      proc,
      healthUrl: "http://service.test/health",
    }
    let probeSignal: AbortSignal | undefined
    const readiness = waitForHealth(
      service,
      1_000,
      async (_url, init) => {
        probeSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
      500,
    )

    await Promise.resolve()
    proc.exitCode = 1
    proc.emit("close", 1, null)

    await expect(readiness).rejects.toThrow("web-ws-do exited before readiness (code 1, signal null)")
    expect(probeSignal?.aborted).toBe(true)
  })

  it("does not pass the service array index as a readiness timeout", async () => {
    const observedTimeouts: Array<number | undefined> = []
    const services = [
      { name: "web", proc: {} as never, healthUrl: "http://localhost:3000/api/health" },
      { name: "ws-do", proc: {} as never, healthUrl: "http://localhost:8789/health" },
    ]

    await waitForServicesReady(services, async (_service, timeoutMs) => {
      observedTimeouts.push(timeoutMs)
    })

    expect(observedTimeouts).toEqual([undefined, undefined])
  })
})

import { describe, expect, it } from "vitest"
import {
  hasExactHealth,
  readinessExitMessage,
  serviceDefinitions,
  waitForServicesReady,
  wranglerLogEnvironment,
} from "./e2e-ui/_setup/services"
import { resolveMachineWsUrl, resolveWsUrl } from "./e2e-ui/_setup/paths"

describe("UI E2E service definitions", () => {
  it("uses one Wrangler runtime for web and ws-do in CI", () => {
    const definitions = serviceDefinitions(true)

    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ name: "web-ws-do" })
    expect(definitions[0]).toMatchObject({
      expectedStatus: 200,
      expectedBody: { status: "ok" },
    })
    expect(definitions[0]?.args).toEqual(expect.arrayContaining([
      "src/web/wrangler.toml",
      "src/ws-do/wrangler.toml",
      "--persist-to",
      "src/web/.wrangler/state",
    ]))
  })

  it("keeps the fast two-process topology for local iteration", () => {
    expect(serviceDefinitions(false).map((definition) => definition.name)).toEqual(["web", "ws-do"])
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

  it("turns a child close before readiness into an immediate failure", () => {
    expect(readinessExitMessage("web-ws-do", null, null)).toBeNull()
    expect(readinessExitMessage("web-ws-do", 1, null))
      .toBe("web-ws-do exited before readiness (code 1, signal null)")
    expect(readinessExitMessage("web-ws-do", null, "SIGTERM"))
      .toBe("web-ws-do exited before readiness (code null, signal SIGTERM)")
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

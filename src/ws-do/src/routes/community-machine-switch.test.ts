import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createRouterTestContext,
  loadRouter,
  getSharedMocks,
  type RouterHandler,
  type RouterTestContext,
} from "./test-harness"

const sharedMocks = getSharedMocks()
const mockHashCredential = sharedMocks.hashCredential
const mockDoNameFromHash = sharedMocks.doNameFromHash
const mockGetActiveDoNamesForMachine = sharedMocks.getActiveDoNamesForMachine
const loggerMocks = {
  child: sharedMocks.loggerChild,
  debug: sharedMocks.loggerDebug,
}

describe("ws-do router", () => {
  let handler: RouterHandler
  let doMock: RouterTestContext["doMock"]
  let rateLimitMock: RouterTestContext["rateLimitMock"]
  let env: RouterTestContext["env"]

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const context = createRouterTestContext()
    doMock = context.doMock
    rateLimitMock = context.rateLimitMock
    env = context.env
    handler = await loadRouter()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.resetModules()
    doMock = undefined as unknown as RouterTestContext["doMock"]
    rateLimitMock = undefined as unknown as RouterTestContext["rateLimitMock"]
    env = undefined as unknown as RouterTestContext["env"]
    handler = undefined as unknown as RouterHandler
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-model-switch", () => {
    // from/to are required for DO pending attribution; outer body has no `type`
    // — the inner DO endpoint `/push-model-switch` stamps the wire frame.
    const validBody = {
      agentId: "bot-1",
      config: { version: 1, runtime: "claude", model: { kind: "named", name: "claude-sonnet-4-6" }, mode: { kind: "default" } },
      launchId: "l-1",
      from: null as string | null,
      to: "claude-sonnet-4-6" as string | null,
    }

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("forwards attribution body to DO /push-model-switch (no type on inner body)", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-model-switch", {
        method: "POST",
        body: JSON.stringify(validBody),
      })
      const res = await handler.fetch(req, env as any)
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-abc")
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/push-model-switch")
      const parsed = JSON.parse(await stubReq.text())
      expect(parsed).toEqual({
        agentId: "bot-1",
        config: validBody.config,
        launchId: "l-1",
        from: null,
        to: "claude-sonnet-4-6",
      })
      expect(parsed.type).toBeUndefined()
      expect(parsed.config.model).toEqual({ kind: "named", name: "claude-sonnet-4-6" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })

    it("rejects an extra top-level key with 400 (allowlist parity with reset)", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-model-switch", {
        method: "POST",
        body: JSON.stringify({ ...validBody, sneaky: "x" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("rejects a missing/non-object config with 400", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-model-switch", {
        method: "POST",
        body: JSON.stringify({ agentId: "bot-1", config: "nope", launchId: "l-1", from: null, to: "x" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("rejects missing from/to with 400", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-model-switch", {
        method: "POST",
        body: JSON.stringify({
          agentId: "bot-1",
          config: validBody.config,
          launchId: "l-1",
        }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("zero active doNames → { sent: 0 } without erroring", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-model-switch", {
        method: "POST",
        body: JSON.stringify(validBody),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-provider-switch", () => {
    const validBody = {
      agentId: "bot-1",
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l-1",
      from: "claude",
      to: "codex",
    }

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("forwards attribution body to DO /push-provider-switch (no type on inner body)", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
      const req = new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-provider-switch",
        { method: "POST", body: JSON.stringify(validBody) },
      )
      const res = await handler.fetch(req, env as any)
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-abc")
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/push-provider-switch")
      const parsed = JSON.parse(await stubReq.text())
      expect(parsed).toEqual({
        agentId: "bot-1",
        config: validBody.config,
        launchId: "l-1",
        from: "claude",
        to: "codex",
      })
      expect(parsed.type).toBeUndefined()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })

    it("rejects missing from/to with 400", async () => {
      const req = new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-provider-switch",
        {
          method: "POST",
          body: JSON.stringify({
            agentId: "bot-1",
            config: validBody.config,
            launchId: "l-1",
          }),
        },
      )
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("zero active doNames → { sent: 0 }", async () => {
      const req = new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-provider-switch",
        { method: "POST", body: JSON.stringify(validBody) },
      )
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-runtime-config-update", () => {
    const validBody = {
      agentId: "bot-1",
      config: {
        version: 1,
        runtime: "codex",
        model: { kind: "default" },
        mode: { kind: "default" },
        reasoningEffort: "xhigh",
        runtimeConfigRevision: 4,
      },
    }

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("forwards the exact revisioned desired config to the machine DO", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: JSON.stringify(validBody) },
      ), env as any)

      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/push-runtime-config-update")
      expect(JSON.parse(await stubReq.text())).toEqual(validBody)
      await expect(res.json()).resolves.toEqual({ sent: 1 })
    })

    it("rejects extra keys and returns sent:0 when no live machine DO exists", async () => {
      const invalid = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: JSON.stringify({ ...validBody, launchId: "not-allowed" }) },
      ), env as any)
      expect(invalid.status).toBe(400)

      const absent = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: JSON.stringify(validBody) },
      ), env as any)
      await expect(absent.json()).resolves.toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("rejects malformed JSON and missing required fields before resolving a machine", async () => {
      const malformed = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: "{" },
      ), env as any)
      expect(malformed.status).toBe(400)

      const nullBody = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: "null" },
      ), env as any)
      expect(nullBody.status).toBe(400)

      const missing = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: JSON.stringify({ agentId: "", config: null }) },
      ), env as any)
      expect(missing.status).toBe(400)
      expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
    })

    it("returns 503 when the owner-scoped machine resolution fails", async () => {
      mockGetActiveDoNamesForMachine.mockRejectedValue(new Error("d1 unavailable"))

      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
        { method: "POST", body: JSON.stringify(validBody) },
      ), env as any)

      expect(res.status).toBe(503)
      await expect(res.json()).resolves.toEqual({ error: "failed to resolve machine" })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("returns 503 when every active machine DO response is transiently unusable", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response("down", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: "one" }), { status: 200 }))
        .mockRejectedValueOnce(new Error("do unavailable"))

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await handler.fetch(new Request(
          "http://localhost/community-machine/by-id/machine-1/forward-agent-runtime-config-update",
          { method: "POST", body: JSON.stringify(validBody) },
        ), env as any)
        expect(res.status).toBe(503)
        await expect(res.json()).resolves.toEqual({ error: "failed to forward runtime config update" })
      }
    })
  })
})

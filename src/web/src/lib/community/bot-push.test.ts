import { describe, it, expect, vi, beforeEach } from "vitest"

const wsDoFetch = vi.fn()
vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...a: unknown[]) => wsDoFetch(...a),
}))

import { pushAgentResetToMachine } from "./bot-push"

const FAKE_ENV = { WS_DO_WORKER: {}, DEV_WS_DO_URL: undefined } as unknown as Env

describe("pushAgentResetToMachine", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  const CFG = {
    version: 1 as const,
    runtime: "claude",
    model: { kind: "default" as const },
    mode: { kind: "default" as const },
  }

  it("POSTs to /forward-agent-reset with the narrow reset body and returns the ws-do { sent } count", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

    const result = await pushAgentResetToMachine(FAKE_ENV, "machine-1", {
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
    })

    expect(result).toEqual({ sent: 1 })
    expect(wsDoFetch).toHaveBeenCalledTimes(1)
    const [, path, init] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine-1/forward-agent-reset")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ agentId: "bot-1", config: CFG, launchId: "l-1" })
    // Narrow-typed: no `type` field snuck in — that's constructed inside ws-do.
    expect(body.type).toBeUndefined()
  })

  it("returns { sent: 0 } when ws-do responds non-ok (treats as offline for the caller)", async () => {
    wsDoFetch.mockResolvedValue(new Response("boom", { status: 503 }))

    const result = await pushAgentResetToMachine(FAKE_ENV, "machine-1", {
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
    })
    expect(result).toEqual({ sent: 0 })
  })

  it("returns { sent: 0 } when the fetch itself throws (network down)", async () => {
    wsDoFetch.mockRejectedValue(new Error("network"))

    const result = await pushAgentResetToMachine(FAKE_ENV, "machine-1", {
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
    })
    expect(result).toEqual({ sent: 0 })
  })
})

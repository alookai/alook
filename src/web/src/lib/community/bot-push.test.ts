import { describe, it, expect, vi, beforeEach } from "vitest"

const wsDoFetch = vi.fn()
vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...a: unknown[]) => wsDoFetch(...a),
}))

import {
  pushBotEventToMachine,
  pushAgentResetToMachine,
  pushAgentModelSwitchToMachine,
  pushAgentProviderSwitchToMachine,
  pushAgentRuntimeConfigUpdateToMachine,
  pushMachineUpdate,
} from "./bot-push"

const FAKE_ENV = { WS_DO_WORKER: {}, DEV_WS_DO_URL: undefined } as unknown as Env

describe("pushBotEventToMachine agent:event", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  const event = {
    type: "agent:event" as const,
    agentId: "bot-1",
    config: {
      version: 1 as const,
      runtime: "codex",
      model: { kind: "default" as const },
      mode: { kind: "default" as const },
    },
    launchId: "launch-1",
    prompt: "Welcome the user.",
  }

  it("posts the narrow event body and returns the sent count", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

    await expect(pushBotEventToMachine(FAKE_ENV, "machine/1", event)).resolves.toEqual({ sent: 1 })
    const [, path, init, meta] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine%2F1/push")
    expect(JSON.parse(init.body)).toEqual(event)
    expect(meta).toEqual({ label: "machine/1", type: "agent:event" })
  })

  it("reports zero for offline, malformed, and transport failures", async () => {
    wsDoFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))
    await expect(pushBotEventToMachine(FAKE_ENV, "m", event)).resolves.toEqual({ sent: 0 })

    wsDoFetch.mockResolvedValueOnce(new Response("down", { status: 503 }))
    await expect(pushBotEventToMachine(FAKE_ENV, "m", event)).resolves.toEqual({ sent: 0 })

    wsDoFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sent: "one" }), { status: 200 }))
    await expect(pushBotEventToMachine(FAKE_ENV, "m", event)).resolves.toEqual({ sent: 0 })

    wsDoFetch.mockRejectedValueOnce(new Error("network"))
    await expect(pushBotEventToMachine(FAKE_ENV, "m", event)).resolves.toEqual({ sent: 0 })
  })
})

describe("pushMachineUpdate", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  it("POSTs the fixed update route without a caller payload", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

    await expect(pushMachineUpdate(FAKE_ENV, "machine/1")).resolves.toEqual({
      sent: 1,
      deliveryError: false,
    })
    const [, path, init, meta] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine%2F1/forward-update")
    expect(init).toEqual({ method: "POST" })
    expect(meta).toEqual({ label: "machine/1", type: "machine:update" })
  })

  it("distinguishes offline from non-ok, malformed, and thrown delivery failures", async () => {
    wsDoFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))
    await expect(pushMachineUpdate(FAKE_ENV, "m")).resolves.toEqual({
      sent: 0,
      deliveryError: false,
    })

    wsDoFetch.mockResolvedValueOnce(new Response("down", { status: 503 }))
    await expect(pushMachineUpdate(FAKE_ENV, "m")).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })

    wsDoFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sent: "one" }), { status: 200 }))
    await expect(pushMachineUpdate(FAKE_ENV, "m")).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })

    wsDoFetch.mockRejectedValueOnce(new Error("network"))
    await expect(pushMachineUpdate(FAKE_ENV, "m")).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })
  })
})

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

describe("pushAgentModelSwitchToMachine", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  const CFG = {
    version: 1 as const,
    runtime: "claude",
    model: { kind: "named" as const, name: "claude-sonnet-4-6" },
    mode: { kind: "default" as const },
  }

  it("POSTs to /forward-agent-model-switch with from/to and returns { sent, deliveryError:false }", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
    const result = await pushAgentModelSwitchToMachine(FAKE_ENV, "machine-1", {
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
      from: null,
      to: "claude-sonnet-4-6",
    })
    expect(result).toEqual({ sent: 1, deliveryError: false })
    const [, path, init] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine-1/forward-agent-model-switch")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
      from: null,
      to: "claude-sonnet-4-6",
    })
    expect(body.type).toBeUndefined()
  })

  it("distinguishes offline (sent:0, deliveryError:false) from a transport error (deliveryError:true)", async () => {
    const args = {
      agentId: "b",
      config: CFG,
      launchId: "l",
      from: "a" as string | null,
      to: "b" as string | null,
    }
    // 200 with sent:0 → daemon just offline.
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))
    expect(await pushAgentModelSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: false,
    })

    // non-ok → transport error.
    wsDoFetch.mockResolvedValue(new Response("boom", { status: 503 }))
    expect(await pushAgentModelSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: true,
    })

    // thrown fetch → transport error.
    wsDoFetch.mockRejectedValue(new Error("network"))
    expect(await pushAgentModelSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: true,
    })
  })
})

describe("pushAgentProviderSwitchToMachine", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  const CFG = {
    version: 1 as const,
    runtime: "codex",
    model: { kind: "default" as const },
    mode: { kind: "default" as const },
  }

  it("POSTs to /forward-agent-provider-switch with from/to attribution", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
    const result = await pushAgentProviderSwitchToMachine(FAKE_ENV, "machine-1", {
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
      from: "claude",
      to: "codex",
    })
    expect(result).toEqual({ sent: 1, deliveryError: false })
    const [, path, init] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine-1/forward-agent-provider-switch")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      agentId: "bot-1",
      config: CFG,
      launchId: "l-1",
      from: "claude",
      to: "codex",
    })
  })

  it("returns deliveryError on non-ok / thrown fetch; sent:0 offline is not an error", async () => {
    const args = {
      agentId: "b",
      config: CFG,
      launchId: "l",
      from: "claude",
      to: "codex",
    }
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))
    expect(await pushAgentProviderSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: false,
    })
    wsDoFetch.mockResolvedValue(new Response("boom", { status: 503 }))
    expect(await pushAgentProviderSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: true,
    })
    wsDoFetch.mockRejectedValue(new Error("network"))
    expect(await pushAgentProviderSwitchToMachine(FAKE_ENV, "m", args)).toEqual({
      sent: 0,
      deliveryError: true,
    })
  })
})

describe("pushAgentRuntimeConfigUpdateToMachine", () => {
  beforeEach(() => {
    wsDoFetch.mockReset()
  })

  const args = {
    agentId: "bot-1",
    config: {
      version: 1 as const,
      runtime: "codex",
      model: { kind: "default" as const },
      mode: { kind: "default" as const },
      reasoningEffort: "xhigh",
      runtimeConfigRevision: 4,
    },
  }

  it("forwards the exact revisioned desired config", async () => {
    wsDoFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

    await expect(pushAgentRuntimeConfigUpdateToMachine(FAKE_ENV, "machine/1", args)).resolves.toEqual({
      sent: 1,
      deliveryError: false,
    })
    const [, path, init, meta] = wsDoFetch.mock.calls[0]!
    expect(path).toBe("/community-machine/by-id/machine%2F1/forward-agent-runtime-config-update")
    expect(JSON.parse(init.body as string)).toEqual(args)
    expect(meta).toEqual({ label: "machine/1", type: "agent:runtime_config_update" })
  })

  it("distinguishes offline from non-ok, malformed, and thrown delivery failures", async () => {
    wsDoFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    await expect(pushAgentRuntimeConfigUpdateToMachine(FAKE_ENV, "m", args)).resolves.toEqual({
      sent: 0,
      deliveryError: false,
    })

    wsDoFetch.mockResolvedValueOnce(new Response("down", { status: 503 }))
    await expect(pushAgentRuntimeConfigUpdateToMachine(FAKE_ENV, "m", args)).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })

    wsDoFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }))
    await expect(pushAgentRuntimeConfigUpdateToMachine(FAKE_ENV, "m", args)).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })

    wsDoFetch.mockRejectedValueOnce(new Error("network"))
    await expect(pushAgentRuntimeConfigUpdateToMachine(FAKE_ENV, "m", args)).resolves.toEqual({
      sent: 0,
      deliveryError: true,
    })
  })
})

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMockWebSocket } from "../__mocks__/cf"
import {
  cleanupHarness,
  createDO,
  mockGetActiveDoNamesForMachine,
  mockGetBotBindingWithOwner,
  mockStubFetch,
  resetHarness,
} from "./test-harness"

const request = { type: "agent:interrupt", agentId: "bot_1" }
const binding = {
  machineId: "machine_1",
  runtime: "codex",
  ownerUserId: "owner_1",
  name: "Bot",
  discriminator: "0001",
}

describe("agent running-turn interrupt WS routing", () => {
  beforeEach(resetHarness)
  afterEach(cleanupHarness)

  function userSocket(userId = "owner_1") {
    const ws = createMockWebSocket()
    ws.serializeAttachment({ type: "user", userId, authenticated: true })
    return ws
  }

  it("does not forward a non-owner request", async () => {
    const { durable } = createDO()
    const ws = userSocket("other_1")
    mockGetBotBindingWithOwner.mockResolvedValue(binding)

    await durable.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(request))

    expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
    expect(mockStubFetch).not.toHaveBeenCalled()
  })

  it("forwards an owner request unchanged through the existing internal push", async () => {
    const { durable, env } = createDO()
    const ws = userSocket()
    mockGetBotBindingWithOwner.mockResolvedValue(binding)
    mockGetActiveDoNamesForMachine.mockResolvedValue(["do_1"])

    await durable.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(request))

    expect(env.WS_DO.idFromName).toHaveBeenCalledWith("community-machine:do_1")
    const forwarded = mockStubFetch.mock.calls[0]![0] as Request
    expect(forwarded.url).toBe("http://internal/push")
    await expect(forwarded.json()).resolves.toEqual(request)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it("continues to an active DO after a stale DO rejects", async () => {
    const { durable, env } = createDO()
    const ws = userSocket()
    mockGetBotBindingWithOwner.mockResolvedValue(binding)
    mockGetActiveDoNamesForMachine.mockResolvedValue(["stale", "active"])
    mockStubFetch.mockRejectedValueOnce(new Error("stale DO"))

    await durable.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(request))

    expect(env.WS_DO.idFromName).toHaveBeenNthCalledWith(1, "community-machine:stale")
    expect(env.WS_DO.idFromName).toHaveBeenNthCalledWith(2, "community-machine:active")
    expect(mockStubFetch).toHaveBeenCalledTimes(2)
    const forwarded = mockStubFetch.mock.calls[1]![0] as Request
    await expect(forwarded.json()).resolves.toEqual(request)
  })
})

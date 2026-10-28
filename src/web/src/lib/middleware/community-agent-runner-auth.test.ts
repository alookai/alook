import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFindRunnerKey = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotOwnedBy = vi.fn()
const mockGetBotBinding = vi.fn()
const mockLogWarn = vi.fn()

vi.mock("@alook/shared", () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => mockLogWarn(...args) }),
  withD1Retry: async (fn: () => Promise<unknown>) => fn(),
  queries: {
    communityMachine: {
      findActiveAgentRunnerKeyByBearer: (...args: unknown[]) => mockFindRunnerKey(...args),
    },
    user: {
      getUserInternal: (...args: unknown[]) => mockGetUserInternal(...args),
    },
    communityBot: {
      getBotOwnedBy: (...args: unknown[]) => mockGetBotOwnedBy(...args),
      getBotBinding: (...args: unknown[]) => mockGetBotBinding(...args),
    },
  },
}))

import { resolveBotActor, resolveOwnedBotActor } from "./community-agent-runner-auth"

describe("resolveBotActor active entitlement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindRunnerKey.mockResolvedValue({
      userId: "owner_1",
      machineId: "machine_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "machine_1", isActive: true })
  })

  it("resolves an active bot runner key", async () => {
    await expect(resolveBotActor({} as never, "Bearer crk_valid")).resolves.toEqual({
      kind: "bot",
      actor: {
        botUserId: "bot_1",
        ownerUserId: "owner_1",
        machineId: "machine_1",
        isActive: true,
      },
    })
  })

  it("rejects a stale runner key after its bot becomes inactive", async () => {
    mockGetBotBinding.mockResolvedValue({ machineId: "machine_1", isActive: false })

    const result = await resolveBotActor({} as never, "Bearer crk_valid")

    expect(result.kind).toBe("error")
    if (result.kind !== "error") throw new Error("expected auth error")
    expect(result.response.status).toBe(401)
    await expect(result.response.json()).resolves.toEqual({ error: "bot binding mismatch" })
  })

  it("carries inactive binding state only when the caller explicitly allows it", async () => {
    mockGetBotBinding.mockResolvedValue({ machineId: "machine_1", isActive: false })

    await expect(resolveBotActor(
      {} as never,
      "Bearer crk_valid",
      { allowInactive: true },
    )).resolves.toEqual({
      kind: "bot",
      actor: {
        botUserId: "bot_1",
        ownerUserId: "owner_1",
        machineId: "machine_1",
        isActive: false,
      },
    })
  })
})


describe("resolveOwnedBotActor", () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetBotOwnedBy.mockResolvedValue({ id: "bot_1", machineId: "machine_1", isActive: true }) })
  it("uses an owner-scoped live bot lookup and its real machine binding", async () => {
    expect(await resolveOwnedBotActor({} as never, "bot_1", "owner_1")).toEqual({ kind: "bot", actor: { botUserId: "bot_1", ownerUserId: "owner_1", machineId: "machine_1", isActive: true } })
    expect(mockGetBotOwnedBy).toHaveBeenCalledWith({}, "bot_1", "owner_1")
    expect(mockFindRunnerKey).not.toHaveBeenCalled()
  })
  it.each(["foreign", "deleted", "missing", ""])("rejects %s with the same not-found response", async (id) => {
    mockGetBotOwnedBy.mockResolvedValue(null)
    const result = await resolveOwnedBotActor({} as never, id, "owner_1")
    expect(result.kind).toBe("error")
    if (result.kind === "error") expect(result.response.status).toBe(404)
  })
  it("rejects an unbound bot even when inactive identities are permitted", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "bot_1", machineId: null, isActive: false })
    const result = await resolveOwnedBotActor({} as never, "bot_1", "owner_1", { allowInactive: true })
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.response.status).toBe(403)
  })
  it("keeps inactive policy explicit without treating a bound offline machine as unauthenticated", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "bot_1", machineId: "machine_1", isActive: false })
    const denied = await resolveOwnedBotActor({} as never, "bot_1", "owner_1")
    if (denied.kind !== "error") throw new Error("expected error")
    expect(denied.response.status).toBe(403)
    expect(await resolveOwnedBotActor({} as never, "bot_1", "owner_1", { allowInactive: true })).toMatchObject({ kind: "bot", actor: { isActive: false } })
  })
  it("returns retryable service failure when the ownership lookup fails", async () => {
    mockGetBotOwnedBy.mockRejectedValue(new Error("D1 unavailable"))
    const result = await resolveOwnedBotActor({} as never, "bot_1", "owner_1")
    if (result.kind !== "error") throw new Error("expected error")
    expect(result.response.status).toBe(503)
    expect(result.response.headers.get("Retry-After")).toBe("1")
  })
})

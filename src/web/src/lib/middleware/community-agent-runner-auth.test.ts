import { beforeEach, describe, expect, it, vi } from "vitest"

const mockFindRunnerKey = vi.fn()
const mockGetUserInternal = vi.fn()
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
      getBotBinding: (...args: unknown[]) => mockGetBotBinding(...args),
    },
  },
}))

import { resolveBotActor } from "./community-agent-runner-auth"

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

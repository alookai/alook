import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetCloudflareContext = vi.fn()
const mockWaitUntil = vi.fn()
const mockMediaDelete = vi.fn()
const mockGetMachineByIdForUser = vi.fn()
const mockListBotsBoundToMachine = vi.fn()
const mockGetBotOwnedBy = vi.fn()
const mockListBotServerMemberships = vi.fn()
const mockSoftDeleteBot = vi.fn()
const mockRevokeCredentialsForMachine = vi.fn()
const mockRevokeRunnerKeysForMachine = vi.fn()
const mockDeleteMachineForUser = vi.fn()
const mockForceCloseCommunityMachinesByDoNames = vi.fn()
const mockFanOutToServerMembers = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...args: unknown[]) => mockGetCloudflareContext(...args),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...args: unknown[]) => mockGetBotOwnedBy(...args),
        listBotsBoundToMachine: (...args: unknown[]) => mockListBotsBoundToMachine(...args),
        listBotServerMemberships: (...args: unknown[]) => mockListBotServerMemberships(...args),
        softDeleteBot: (...args: unknown[]) => mockSoftDeleteBot(...args),
      },
      communityMachine: {
        getMachineByIdForUser: (...args: unknown[]) => mockGetMachineByIdForUser(...args),
        revokeCredentialsForMachine: (...args: unknown[]) => mockRevokeCredentialsForMachine(...args),
        revokeRunnerKeysForMachine: (...args: unknown[]) => mockRevokeRunnerKeysForMachine(...args),
        deleteMachineForUser: (...args: unknown[]) => mockDeleteMachineForUser(...args),
      },
    },
  }
})

vi.mock("@/lib/community/machine-disconnect", () => ({
  forceCloseCommunityMachinesByDoNames: (...args: unknown[]) =>
    mockForceCloseCommunityMachinesByDoNames(...args),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...args: unknown[]) => mockFanOutToServerMembers(...args),
  broadcastToUserSafe: (...args: unknown[]) => mockBroadcastToUserSafe(...args),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {}, COMMUNITY_MEDIA: { delete: (...args: unknown[]) => mockMediaDelete(...args) } },
      userId: "u1",
      email: "u@example.com",
      params,
    })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { DELETE } from "./route"

function request(cascade?: boolean) {
  return new NextRequest("http://localhost/api/community/machines/m1", {
    method: "DELETE",
    headers: cascade === undefined ? undefined : { "Content-Type": "application/json" },
    body: cascade === undefined ? undefined : JSON.stringify({ cascade }),
  })
}

const ctx = { params: Promise.resolve({ id: "m1" }) } as any

describe("DELETE /api/community/machines/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMachineByIdForUser.mockResolvedValue({ id: "m1", userId: "u1" })
    mockListBotsBoundToMachine.mockResolvedValue([])
    mockGetBotOwnedBy.mockImplementation(async (_db: unknown, id: string) => ({
      id,
      avatarObjectKey: null,
    }))
    mockListBotServerMemberships.mockResolvedValue([])
    mockSoftDeleteBot.mockResolvedValue(true)
    mockRevokeCredentialsForMachine.mockResolvedValue({ doNames: ["do-1"] })
    mockRevokeRunnerKeysForMachine.mockResolvedValue(undefined)
    mockForceCloseCommunityMachinesByDoNames.mockResolvedValue(undefined)
    mockDeleteMachineForUser.mockResolvedValue({ id: "m1" })
    mockBroadcastToUserSafe.mockResolvedValue(undefined)
    mockMediaDelete.mockResolvedValue(undefined)
    mockGetCloudflareContext.mockResolvedValue({ ctx: { waitUntil: mockWaitUntil } })
  })

  it("keeps the existing 409 and does not acquire context when bots exist without cascade", async () => {
    mockListBotsBoundToMachine.mockResolvedValue([{ id: "b1", name: "Bot" }])

    const res = await DELETE(request(), ctx)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "MACHINE_HAS_BOTS",
      bots: [{ id: "b1", name: "Bot" }],
    })
    expect(mockGetCloudflareContext).not.toHaveBeenCalled()
    expect(mockSoftDeleteBot).not.toHaveBeenCalled()
    expect(mockDeleteMachineForUser).not.toHaveBeenCalled()
  })

  it("keeps the zero-bot path free of ExecutionContext and avatar cleanup", async () => {
    const res = await DELETE(request(), ctx)

    expect(res.status).toBe(204)
    expect(mockGetCloudflareContext).not.toHaveBeenCalled()
    expect(mockWaitUntil).not.toHaveBeenCalled()
    expect(mockMediaDelete).not.toHaveBeenCalled()
    expect(mockDeleteMachineForUser).toHaveBeenCalledWith(expect.anything(), "u1", "m1")
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", {
      type: "community:machine.removed",
      machineId: "m1",
    })
  })

  it("fails before the first bot mutation when nonempty cascade cannot acquire context", async () => {
    mockListBotsBoundToMachine.mockResolvedValue([{ id: "b1", name: "Bot" }])
    mockGetCloudflareContext.mockRejectedValue(new Error("no context"))

    const res = await DELETE(request(true), ctx)

    expect(res.status).toBe(500)
    expect(mockListBotServerMemberships).not.toHaveBeenCalled()
    expect(mockSoftDeleteBot).not.toHaveBeenCalled()
    expect(mockRevokeCredentialsForMachine).not.toHaveBeenCalled()
    expect(mockDeleteMachineForUser).not.toHaveBeenCalled()
  })

  it("cleans and fans out only per-bot D1 winners in a mixed cascade", async () => {
    mockListBotsBoundToMachine.mockResolvedValue([
      { id: "b1", name: "One" },
      { id: "b2", name: "Two" },
    ])
    mockListBotServerMemberships
      .mockResolvedValueOnce(["s1"])
      .mockResolvedValueOnce(["s2"])
    mockSoftDeleteBot.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    mockGetBotOwnedBy
      .mockResolvedValueOnce({ id: "b1", avatarObjectKey: "bot-avatar/b1/objects/current" })
      .mockResolvedValueOnce({ id: "b2", avatarObjectKey: "bot-avatar/b2/objects/current" })

    const res = await DELETE(request(true), ctx)

    expect(res.status).toBe(204)
    expect(mockMediaDelete).toHaveBeenCalledWith([
      "bot-avatar/b1/objects/current",
      "bot-avatar/b1",
    ])
    expect(mockWaitUntil).toHaveBeenCalledOnce()
    expect(mockFanOutToServerMembers).toHaveBeenCalledOnce()
    expect(mockFanOutToServerMembers).toHaveBeenCalledWith("s1", {
      type: "community:member.leave",
      serverId: "s1",
      userId: "b1",
    })
  })

  it("finally registers earlier winner cleanup when a later bot delete throws", async () => {
    mockListBotsBoundToMachine.mockResolvedValue([
      { id: "b1", name: "One" },
      { id: "b2", name: "Two" },
    ])
    mockSoftDeleteBot
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("later D1 failure"))

    await expect(DELETE(request(true), ctx)).rejects.toThrow("later D1 failure")

    expect(mockMediaDelete).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockWaitUntil).toHaveBeenCalledOnce()
    expect(mockRevokeCredentialsForMachine).not.toHaveBeenCalled()
  })

  it("finally registers the current winner before a synchronous member fanout failure escapes", async () => {
    mockListBotsBoundToMachine.mockResolvedValue([{ id: "b1", name: "One" }])
    mockListBotServerMemberships.mockResolvedValue(["s1"])
    mockFanOutToServerMembers.mockImplementation(() => {
      throw new Error("fanout setup failure")
    })

    await expect(DELETE(request(true), ctx)).rejects.toThrow("fanout setup failure")

    expect(mockMediaDelete).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockWaitUntil).toHaveBeenCalledOnce()
  })

  it("characterizes the existing machine-level duplicate winner behavior without changing it", async () => {
    mockDeleteMachineForUser.mockResolvedValue(null)

    const res = await DELETE(request(), ctx)

    expect(res.status).toBe(204)
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", {
      type: "community:machine.removed",
      machineId: "m1",
    })
  })
})

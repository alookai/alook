import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  deleteRows: vi.fn(),
  getUser: vi.fn(),
  deleteStorage: vi.fn(),
  forceClose: vi.fn(),
  pushBot: vi.fn(),
  broadcastDaemon: vi.fn(),
  fanOut: vi.fn(),
  broadcastUser: vi.fn(),
  revokeProvider: vi.fn(),
  invalidateMany: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@alook/shared", () => ({
  createLogger: () => ({ warn: mocks.warn }),
  WS_EVENTS: {
    SERVER_DELETE: "server:delete",
    READ_STATE_ADVANCED: "read_state:advanced",
  },
  queries: {
    accountDeletion: {
      getAccountDeletionSnapshot: mocks.getSnapshot,
      deleteAccountRows: mocks.deleteRows,
    },
    user: { getUserInternal: mocks.getUser },
  },
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/cache", () => ({
  cacheKeys: { machineToken: (token: string) => `mt:${token.slice(0, 20)}` },
  invalidateMany: mocks.invalidateMany,
}))
vi.mock("@/lib/community/community-media-cleanup", () => ({ deleteCommunityMediaObjects: vi.fn() }))
vi.mock("./storage", () => ({ deleteAccountStorage: mocks.deleteStorage }))
vi.mock("./provider-revocation", () => ({ revokeProviderAccount: mocks.revokeProvider }))
vi.mock("@/lib/community/machine-disconnect", () => ({
  forceCloseCommunityMachinesByDoNames: mocks.forceClose,
}))
vi.mock("@/lib/community/bot-push", () => ({ pushBotEventToMachine: mocks.pushBot }))
vi.mock("@/lib/broadcast", () => ({ broadcastToDaemon: mocks.broadcastDaemon }))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToUsers: mocks.fanOut,
  broadcastToUserSafe: mocks.broadcastUser,
}))

import { executeAccountDeletion } from "./execution"

function snapshot(id: string) {
  return {
    identity: { id: "user-1", email: "owner@example.com", isBot: false, avatarObjectKey: null },
    identities: [],
    providers: [],
    ownedWorkspaceIds: [],
    ownedAgentIds: [],
    legacyDaemons: [],
    machineTokens: [],
    machineDoNames: [],
    botBindings: [],
    ownedServers: [],
    readStateUserIds: [],
    media: {
      communityExactKeys: [id],
      communityPrefixes: [],
      emailExactKeys: [],
      emailPrefixes: [],
      deletingEmailAttachments: [],
      survivingEmailAttachments: [],
      bugReportExactKeys: [],
      bugReportPrefixes: [],
    },
  }
}

describe("account deletion execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const effect of [
      mocks.deleteStorage,
      mocks.forceClose,
      mocks.pushBot,
      mocks.broadcastDaemon,
      mocks.fanOut,
      mocks.broadcastUser,
      mocks.revokeProvider,
      mocks.invalidateMany,
    ]) effect.mockResolvedValue(undefined)
  })

  it("cleans an initial and final primary snapshot before the D1 batch", async () => {
    const initial = { ...snapshot("initial"), machineTokens: ["al_initial_token"] }
    const final = { ...snapshot("final"), machineTokens: ["al_final_token"] }
    mocks.getSnapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce(final)
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })
    const waitUntil = vi.fn()

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })

    expect(mocks.deleteStorage).toHaveBeenNthCalledWith(1, expect.anything(), initial)
    expect(mocks.deleteStorage).toHaveBeenNthCalledWith(2, expect.anything(), final)
    expect(mocks.deleteRows).toHaveBeenCalledWith({ primary: true }, final)
    expect(mocks.deleteStorage.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.deleteRows.mock.invocationCallOrder[0])
    expect(mocks.invalidateMany).toHaveBeenCalledWith([
      "mt:al_initial_token",
      "mt:al_final_token",
    ])
    expect(waitUntil).toHaveBeenCalledOnce()
  })

  it("invalidates the initial machine tokens when another request already removed the user", async () => {
    const initial = { ...snapshot("initial"), machineTokens: ["al_initial_token"] }
    mocks.getSnapshot.mockResolvedValueOnce(initial).mockResolvedValueOnce(null)

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "missing" })

    expect(mocks.invalidateMany).toHaveBeenCalledWith(["mt:al_initial_token"])
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it("does not run the D1 batch after synchronous storage cleanup fails", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("initial"))
    mocks.deleteStorage.mockRejectedValue(new Error("R2 unavailable"))

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "failed" })
    expect(mocks.getSnapshot).toHaveBeenCalledOnce()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it("treats an ambiguous D1 error as success only when a new primary no longer finds the user", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockRejectedValue(new Error("transport lost"))
    mocks.getUser.mockResolvedValue(null)

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })

    mocks.getUser.mockResolvedValue({ id: "user-1" })
    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "failed" })
  })

  it("keeps committed deletion successful when post-commit effects reject", async () => {
    const current = {
      ...snapshot("current"),
      providers: [{ providerId: "github", accountId: "account", accessToken: "token", refreshToken: null }],
      legacyDaemons: [{ daemonId: "daemon-1", workspaceId: "workspace-1" }],
      machineTokens: ["al_1234567890abcdefghijklmnop"],
      machineDoNames: ["machine-do"],
      botBindings: [{ botId: "bot-1", machineId: "machine-1" }],
      ownedServers: [{ id: "server-1", icon: null, memberIds: ["member-1"] }],
      readStateUserIds: ["member-1"],
    }
    mocks.getSnapshot.mockResolvedValue(current)
    mocks.deleteRows.mockResolvedValue({
      deleted: true,
      readStateRevisions: [{ userId: "member-1", revision: 7 }],
    })
    mocks.forceClose.mockRejectedValue(new Error("socket unavailable"))
    let postCommit: Promise<unknown> | undefined

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: (promise) => { postCommit = promise } },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })
    await expect(postCommit).resolves.toBeUndefined()

    expect(mocks.pushBot).toHaveBeenCalled()
    expect(mocks.broadcastDaemon).toHaveBeenCalled()
    expect(mocks.fanOut).toHaveBeenCalled()
    expect(mocks.broadcastUser).toHaveBeenCalled()
    expect(mocks.revokeProvider).toHaveBeenCalled()
    expect(mocks.invalidateMany).toHaveBeenCalledWith(["mt:al_1234567890abcdefg"])
    expect(mocks.warn).toHaveBeenCalledWith(
      "account_deletion_post_commit_effects_failed",
      { failures: 1 },
    )
  })

  it("keeps a committed deletion successful when machine-token invalidation fails", async () => {
    const current = {
      ...snapshot("current"),
      machineTokens: ["al_stale_token"],
    }
    mocks.getSnapshot.mockResolvedValue(current)
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })
    mocks.invalidateMany.mockRejectedValue(new Error("KV unavailable"))

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })
  })

  it("fails closed when the delete batch reports no deleted user and the user remains", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockResolvedValue({ deleted: false, readStateRevisions: [] })
    mocks.getUser.mockResolvedValue({ id: "user-1" })

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "failed" })
  })

  it("keeps a committed deletion successful when waitUntil is unavailable", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: () => { throw new Error("unavailable") } },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })
    expect(mocks.warn).toHaveBeenCalledWith("account_deletion_wait_until_unavailable")
  })
})

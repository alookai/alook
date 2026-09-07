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
    ]) effect.mockResolvedValue(undefined)
  })

  it("cleans an initial and final primary snapshot before the D1 batch", async () => {
    const initial = snapshot("initial")
    const final = snapshot("final")
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
    expect(waitUntil).toHaveBeenCalledOnce()
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
    expect(mocks.warn).toHaveBeenCalledWith(
      "account_deletion_post_commit_effects_failed",
      { failures: 1 },
    )
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  beginDeletion: vi.fn(),
  closeBilling: vi.fn(),
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
  unsubscribe: vi.fn(),
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
      beginAccountDeletion: mocks.beginDeletion,
      deleteAccountRows: mocks.deleteRows,
    },
    user: { getUserInternal: mocks.getUser },
  },
}))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({ primary: true }) }))
vi.mock("@/lib/resend-contacts", () => ({ unsubscribeResendContact: mocks.unsubscribe }))
vi.mock("@/lib/cache", () => ({
  cacheKeys: { machineToken: (token: string) => `mt:${token.slice(0, 20)}` },
  invalidateMany: mocks.invalidateMany,
}))
vi.mock("@/lib/community/community-media-cleanup", () => ({ deleteCommunityMediaObjects: vi.fn() }))
vi.mock("@/lib/billing/service", () => ({ closeAccountBilling: mocks.closeBilling }))
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
      mocks.beginDeletion,
      mocks.closeBilling,
      mocks.deleteStorage,
      mocks.forceClose,
      mocks.pushBot,
      mocks.broadcastDaemon,
      mocks.fanOut,
      mocks.broadcastUser,
      mocks.revokeProvider,
      mocks.invalidateMany,
      mocks.unsubscribe,
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
    expect(mocks.unsubscribe).toHaveBeenCalledWith(expect.anything(), final.identity.email)
    expect(mocks.unsubscribe.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.deleteRows.mock.invocationCallOrder[0])
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
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
  })

  it("does not run the D1 batch after synchronous storage cleanup fails", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("initial"))
    mocks.deleteStorage.mockRejectedValue(new Error("R2 unavailable"))

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "pending" })
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2)
    expect(mocks.deleteRows).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
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

    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    mocks.unsubscribe.mockClear()

    mocks.getUser.mockResolvedValue({ id: "user-1" })
    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "pending" })
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
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
    mocks.broadcastDaemon.mockRejectedValue(new Error("socket unavailable"))
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

  it("revokes Apple synchronously before deleting local account rows", async () => {
    const current = {
      ...snapshot("current"),
      providers: [{
        providerId: "apple",
        accountId: "stable-sub",
        accessToken: "access",
        refreshToken: "refresh",
      }],
    }
    mocks.getSnapshot.mockResolvedValue(current)
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "deleted" })

    expect(mocks.revokeProvider).toHaveBeenCalledOnce()
    expect(mocks.revokeProvider).toHaveBeenCalledWith(expect.anything(), current.providers[0])
    expect(mocks.revokeProvider.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deleteStorage.mock.invocationCallOrder[0])
    expect(mocks.deleteStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deleteStorage.mock.invocationCallOrder[1])
    expect(mocks.deleteStorage.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.deleteRows.mock.invocationCallOrder[0])
  })

  it("preserves the local account when Apple revocation fails", async () => {
    const current = {
      ...snapshot("current"),
      providers: [{
        providerId: "apple",
        accountId: "stable-sub",
        accessToken: "access",
        refreshToken: "refresh",
      }],
    }
    mocks.getSnapshot.mockResolvedValue(current)
    mocks.revokeProvider.mockRejectedValue(new Error("Apple unavailable"))

    await expect(executeAccountDeletion(
      {} as never,
      {} as never,
      { waitUntil: vi.fn() },
      "user-1",
    )).resolves.toEqual({ kind: "pending" })

    expect(mocks.deleteStorage).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
    expect(mocks.invalidateMany).toHaveBeenCalled()
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
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
    )).resolves.toEqual({ kind: "pending" })
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
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

  it("owns pending unsubscribe in the original single background group after confirmed deletion", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })
    let finish: (() => void) | undefined
    mocks.unsubscribe.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    const owner = { waitUntil: vi.fn(function (this: unknown, _promise: Promise<unknown>) { expect(this).toBe(owner) }) }
    const env = { RESEND_API_KEY: "mock-key" }
    await expect(executeAccountDeletion({} as never, env as never, owner, "user-1"))
      .resolves.toEqual({ kind: "deleted" })
    expect(owner.waitUntil).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledWith(env, "owner@example.com")
    finish?.()
    await owner.waitUntil.mock.calls[0]?.[0]
  })

  it("keeps committed deletion successful when the contact effect rejects", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })
    mocks.unsubscribe.mockRejectedValueOnce(new Error("contact provider unavailable"))
    const waitUntil = vi.fn()
    await expect(executeAccountDeletion({} as never, {} as never, { waitUntil }, "user-1"))
      .resolves.toEqual({ kind: "deleted" })
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledWith("account_deletion_post_commit_effects_failed", { failures: 1 })
  })

  it("does not invent an unsubscribe for an initially missing account", async () => {
    mocks.getSnapshot.mockResolvedValueOnce(null)
    const waitUntil = vi.fn()
    await expect(executeAccountDeletion({} as never, {} as never, { waitUntil }, "user-1"))
      .resolves.toEqual({ kind: "missing" })
    expect(mocks.unsubscribe).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it("unsubscribes when a no-op delete batch is confirmed absent on a fresh primary", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.deleteRows.mockResolvedValue({ deleted: false, readStateRevisions: [] })
    mocks.getUser.mockResolvedValueOnce(null)
    const waitUntil = vi.fn()
    await expect(executeAccountDeletion({} as never, {} as never, { waitUntil }, "user-1"))
      .resolves.toEqual({ kind: "deleted" })
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.getUser.mock.invocationCallOrder[0])
    expect(waitUntil).toHaveBeenCalledOnce()
  })
  it("keeps cleanup pending until billing and machine shutdown succeed", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.closeBilling.mockRejectedValueOnce(new Error("Stripe unavailable"))
    const ctx = { waitUntil: vi.fn() }
    await expect(executeAccountDeletion({} as never, {} as never, ctx, "user-1")).resolves.toEqual({ kind: "pending" })
    expect(mocks.beginDeletion).toHaveBeenCalledBefore(mocks.closeBilling)
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
    mocks.deleteRows.mockResolvedValue({ deleted: true, readStateRevisions: [] })
    await expect(executeAccountDeletion({} as never, {} as never, ctx, "user-1")).resolves.toEqual({ kind: "deleted" })
    expect(mocks.closeBilling).toHaveBeenCalledBefore(mocks.deleteStorage)
  })
  it("does not erase media while an existing machine cannot be disconnected", async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot("current"))
    mocks.forceClose.mockRejectedValueOnce(new Error("DO unavailable"))
    await expect(executeAccountDeletion({} as never, {} as never, { waitUntil: vi.fn() }, "user-1")).resolves.toEqual({ kind: "pending" })
    expect(mocks.deleteStorage).not.toHaveBeenCalled()
  })

})

it.each([true, false, "unavailable"])("classifies an ambiguous deletion start using persisted state: %s", async (state) => {
  vi.clearAllMocks()
  mocks.beginDeletion.mockRejectedValueOnce(new Error("D1 response lost"))
  if (state === "unavailable") mocks.getUser.mockRejectedValueOnce(new Error("D1 unavailable"))
  else mocks.getUser.mockResolvedValueOnce({ deletedAt: state ? "2026-01-01" : null })
  await expect(executeAccountDeletion({} as never, {} as never, { waitUntil: vi.fn() }, "user-1"))
    .resolves.toEqual({ kind: state === true ? "pending" : "failed" })
  expect(mocks.deleteStorage).not.toHaveBeenCalled()
})

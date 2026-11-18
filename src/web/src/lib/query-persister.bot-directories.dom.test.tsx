import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { fullResourceBundleFixture, invitesReadFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { invitesQueryFn } from "@/hooks/community/use-server-panels"
import { useBotMarks } from "@/hooks/community/use-bot-marks"
import { useBotAuditLog } from "@/hooks/community/use-bot-audit-log"
import { useBotAuditPreview } from "@/hooks/community/use-bot-audit-preview"
import { useBotMemberships } from "@/hooks/community/use-bot-memberships"
import { useBotNotificationSetting, useSetBotNotificationSetting } from "@/hooks/community/use-notification-settings"
import { useServerAdminChannels } from "@/hooks/community/use-server-admin-channels"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { captureCommunityLiveSnapshotToken, completeCommunityPublication, discardCommunityRestoreReplacements, publishCommunityMemberRole, publishCommunityResourceBundle, restoreCommunityCollections, retireCommunityChannelReading } from "./community-db/sync"
import { cacheStore } from "./query-cache-store"
import { blobKeyFor } from "./persisted-account-identity"
import { ApiError } from "./errors"
import { communityKeys } from "./query-keys"
import { isBotDirectoryWindowKey } from "./community/bot-directory-window"
import { searchCommunityUsers } from "./community/user-search"
import { retireBotDirectoryScopes, retireBotServerDirectories } from "./community/bot-directory-lifecycle"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "./query-persister"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const writers: ReturnType<typeof createIdbPersister>[] = []
const date = "2026-11-01T12:00:00.000Z"
const keys = [communityKeys.botMarks("bot"), communityKeys.botAuditLog("bot"), communityKeys.botAuditPreview("bot"), communityKeys.botMemberships("bot"),
  communityKeys.botNotificationSetting("bot", "server", "server"), communityKeys.botNotificationSetting("bot", "channel", "bot-private"), communityKeys.adminChannels("server")]

afterEach(async () => {
  vi.restoreAllMocks()
  for (const writer of writers.splice(0)) writer.stopPersisting()
  for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
  api.mockReset()
})

function backend(empty: boolean) {
  const state = { offline: false, ownerMissing: false, left: false, level: empty ? null : "mentions" as string | null, commands: [] as Array<{ path: string; method: string }>, admin: undefined as Promise<unknown> | undefined }
  api.mockImplementation(async (path: string, options: { method?: string; body?: string; headers?: HeadersInit } = {}) => {
    const url = new URL(path, "https://fixture.invalid")
    if (options.method && options.method !== "GET") {
      state.commands.push({ path, method: options.method })
      if (options.method === "PUT") state.level = JSON.parse(options.body!).level
      if (url.pathname === "/api/community/channels/resolve/members/self") state.left = true
      return {}
    }
    if (state.offline) throw new ApiError("offline", 503)
    if (state.ownerMissing && (url.pathname.startsWith("/api/community/bots/") || url.pathname === "/api/community/servers/channels")) throw new ApiError("bot not found", 404)
    if (url.pathname === "/api/community/users/search") {
      const query = url.searchParams.get("q")!
      return { users: [{ id: query, name: query, discriminator: "0042", image: null, avatarVersion: 0 }] }
    }
    if (url.pathname.endsWith("/marks")) return { marked: empty ? [] : [{ id: "mark", server: "Studio", serverId: "server", channel: "private", channelId: "bot-private", parentChannelId: null,
      m: { id: "message", authorId: "author", authorName: "Saved author", authorAvatar: "A", authorAvatarVersion: 2, content: "Saved marked work", seq: 4, createdAt: date } }] }
    if (url.pathname.endsWith("/audit-log")) {
      const count = empty ? 0 : url.searchParams.get("kind") === "text" ? 10 : 50
      const events = Array.from({ length: count }, (_, index) => ({ id: `event-${index}`, kind: "text", payload: { text: `Saved thought ${index}`, truncated: false, chars: `Saved thought ${index}`.length },
        sessionId: null, launchId: null, createdAt: new Date(Date.parse(date) - index * 1000).toISOString() }))
      const last = events.at(-1)
      return { events, nextCursor: last ? { beforeCreatedAt: last.createdAt, beforeId: last.id } : null }
    }
    if (url.pathname === "/api/community/servers/channels") return {
      servers: empty ? [] : [{ id: "server", name: "Studio", handle: "Studio#0042", icon: null, canLeave: true }],
      groups: empty || state.left ? [] : [{ category: null, channels: [{ id: "bot-private", ref: "/Studio#0042/private", name: "private", type: "text", visibility: "private" }] }],
    }
    if (url.pathname.includes("/notifications/")) return { level: url.pathname.includes("/server/") ? state.level : null, serverId: "server" }
    if (url.pathname.endsWith("/channels/admin")) return state.admin ?? { channels: empty ? [] : [{ id: "admin-private", name: "Administration", type: "forum", category: null, creator: null, createdAt: date }] }
    throw new Error(`Unexpected C request ${path}`)
  })
  return state
}

function newOwner(account: string, waitForRestore?: Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
  const registry = createCommunityDbRegistry(client, account, { waitForRestore })
  const writer = createIdbPersister(account)
  registry.bindAuthentication(() => account, () => writer.retireAccount(), writer.retireChannels, writer.retireAuxiliaryScopes, writer.captureAuxiliaryReadEpoch)
  owners.add(registry); writers.push(writer)
  return { account, client, registry, writer }
}
type Owner = ReturnType<typeof newOwner>

async function seed() {
  const account = `bot-cache-${crypto.randomUUID()}`
  accounts.add(account)
  const owner = newOwner(account)
  await owner.registry.preload()
  await publishCommunityResourceBundle(owner.client, fullResourceBundleFixture(account,
    [serverResourceFixture({ id: "server", ownerId: account })], [], [],
    [profileResourceFixture({ id: account }), profileResourceFixture({ id: "bot", kind: "bot", ownerUserId: account })]),
  { token: captureCommunityLiveSnapshotToken(owner.client) })
  return owner
}

async function save(owner: Owner) {
  const previous = await get<string>(blobKeyFor(owner.account), cacheStore)
  const timestamp = Math.max(Date.now(), previous ? JSON.parse(previous).timestamp + 1 : 0)
  await owner.writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  expect(JSON.parse((await get<string>(blobKeyFor(owner.account), cacheStore))!).timestamp).toBe(timestamp)
}

async function replace(owner: Owner) {
  owner.writer.stopPersisting()
  await owner.registry.cleanup(); owner.client.clear(); owners.delete(owner.registry)
  let release!: () => void
  const next = newOwner(owner.account, new Promise<void>(resolve => { release = resolve }))
  const restore = createCommunityRestorePersister(next.writer, owner.account)
  await persistQueryClientRestore({ queryClient: next.client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(next.registry, input); next.registry.captureRestoredCollections(input); next.registry.runtime.ws.actions.activateProfileAccount(owner.account) }
  finally { discardCommunityRestoreReplacements(next.registry); release() }
  await next.registry.preload()
  return next
}

function mount(owner: Owner) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: owner.account, retainOwner: true }, children)
  return renderHook(() => ({
    marks: useBotMarks("bot"), audit: useBotAuditLog("bot"), text: useBotAuditPreview("bot", true), memberships: useBotMemberships("bot", true),
    server: useBotNotificationSetting("bot", { kind: "server", id: "server" }), channel: useBotNotificationSetting("bot", { kind: "channel", id: "bot-private" }),
    admin: useServerAdminChannels("server", true), setNotification: useSetBotNotificationSetting(),
  }), { wrapper })
}

async function loaded(view: ReturnType<typeof mount>) {
  await waitFor(() => {
    expect(view.result.current.marks.hasData).toBe(true)
    expect(view.result.current.audit.hasData).toBe(true)
    expect(view.result.current.text.hasData).toBe(true)
    expect(view.result.current.memberships.isSuccess).toBe(true)
    expect(view.result.current.server.data).toBeDefined()
    expect(view.result.current.channel.data).toBeDefined()
    expect(view.result.current.admin.channels).toBeDefined()
  })
}

describe("C real hooks through IDB and fresh community owners", () => {
  it.each([false, true])("keeps the actual Bot GET available when optional disk qualification fails=%s", async failCapture => {
    backend(false)
    const owner = await seed()
    expect(await owner.writer.isCurrent()).toBe(true)
    await owner.registry.retireAuxiliaryDisk([{ kind: "bot", id: "bot" }])
    let faultCalls = 0
    if (failCapture) {
      const original = IDBDatabase.prototype.transaction
      vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof original>) {
        if (args[1] === "readonly" && faultCalls++ === 0) throw new DOMException("Optional read qualification unavailable", "UnknownError")
        return original.apply(this, args)
      })
    }
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: owner.account, retainOwner: true }, children)
    const view = renderHook(() => useBotMarks("bot"), { wrapper })
    await waitFor(() => expect(view.result.current.marks[0]?.id).toBe("mark"))
    expect(api.mock.calls.filter(([path]) => path === "/api/community/bots/bot/marks")).toHaveLength(1)
    expect(view.result.current.isError).toBe(false)
    const data = owner.client.getQueryData<{ auxiliaryReadEpoch?: string }>(communityKeys.botMarks("bot"))
    if (failCapture) { expect(faultCalls).toBeGreaterThan(0); expect(data?.auxiliaryReadEpoch).toBeUndefined() }
    else expect(data?.auxiliaryReadEpoch).toEqual(expect.any(String))
    await save(owner)
    const snapshot = await owner.writer.restoreClient()
    expect(snapshot?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(communityKeys.botMarks("bot")))).toBe(!failCapture)
    view.unmount()
  })

  it.each([false, true])("retains every family after request failure, re-save and a third owner (known empty=%s)", async empty => {
    const network = backend(empty)
    let owner = await seed(), view = mount(owner)
    await loaded(view)
    expect(api).toHaveBeenCalledTimes(7)
    expect(view.result.current.audit.events).toHaveLength(empty ? 0 : 50)
    expect(view.result.current.text.events).toHaveLength(empty ? 0 : 10)
    if (!empty) {
      expect(view.result.current.marks.marks[0]?.m.content).toBe("Saved marked work")
      expect(view.result.current.text.events.find(event => event.id === "event-0")?.payload).toMatchObject({ text: "Saved thought 0", truncated: false, chars: 15 })
    }
    await save(owner); view.unmount(); owner = await replace(owner)
    for (const key of keys) expect(owner.client.getQueryData(key)).toBeDefined()
    network.offline = true; view = mount(owner)
    await waitFor(() => {
      for (const key of keys) expect(owner.client.getQueryState(key)?.status).toBe("error")
    })
    expect(view.result.current.marks.marks).toHaveLength(empty ? 0 : 1)
    expect(view.result.current.audit.events).toHaveLength(empty ? 0 : 50)
    expect(view.result.current.text.events).toHaveLength(empty ? 0 : 10)
    expect(view.result.current.memberships.data?.servers).toHaveLength(empty ? 0 : 1)
    expect(view.result.current.memberships.confirmed).toBe(false)
    expect(view.result.current.server.data?.level).toBe(empty ? null : "mentions")
    expect(view.result.current.channel.data?.level).toBeNull()
    expect(view.result.current.server.confirmed).toBe(false)
    expect(view.result.current.admin.channels).toHaveLength(empty ? 0 : 1)
    expect(owner.registry.collections.channels.has("bot-private")).toBe(false)
    expect(owner.registry.collections.channels.has("admin-private")).toBe(false)
    await save(owner); view.unmount(); owner = await replace(owner)
    for (const key of keys) expect(owner.client.getQueryData(key)).toBeDefined()
    expect(owner.client.getQueryData(communityKeys.botMemberships("bot"))).not.toHaveProperty("servers.0.canLeave")
    expect(owner.client.getQueryData(communityKeys.botNotificationSetting("bot", "server", "server"))).toMatchObject({ observed: false, level: empty ? null : "mentions" })
    view = mount(owner)
    await waitFor(() => expect(view.result.current.marks.isError).toBe(true))
    expect(view.result.current.marks.marks).toHaveLength(empty ? 0 : 1)
    expect(view.result.current.text.events).toHaveLength(empty ? 0 : 10)
    expect(network.commands).toEqual([])
    if (!empty) expect(view.result.current.text.events.find(event => event.id === "event-0")?.payload).toMatchObject({ text: "Saved thought 0", truncated: false, chars: 15 })
    view.unmount()
  })

  it("refuses restored commands and qualifies only the real exact fresh reads", async () => {
    const network = backend(false)
    let owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner); view.unmount(); owner = await replace(owner)
    network.offline = true; view = mount(owner)
    await waitFor(() => expect(view.result.current.memberships.isError).toBe(true))
    const target = { kind: "channel" as const, id: "/Studio#0042/private", ref: "/Studio#0042/private", resourceId: "bot-private", name: "private" }
    await act(async () => {
      await expect(view.result.current.memberships.leave(target)).rejects.toMatchObject({ name: "AbortError" })
      await expect(Promise.resolve().then(() => view.result.current.setNotification.mutateAsync({ botId: "bot", scope: { kind: "server", id: "server" }, level: "all" }))).rejects.toMatchObject({ name: "AbortError" })
    })
    expect(network.commands).toEqual([])
    network.offline = false
    await act(async () => { await owner.client.refetchQueries({ predicate: query => isBotDirectoryWindowKey(query.queryKey) }) })
    await waitFor(() => expect(view.result.current.server.confirmed && view.result.current.memberships.confirmed).toBe(true))
    await act(async () => { await view.result.current.setNotification.mutateAsync({ botId: "bot", scope: { kind: "server", id: "server" }, level: "all" }) })
    await act(async () => { expect(await view.result.current.memberships.leave(target)).toBe(true) })
    expect(network.commands).toEqual([{ path: "/api/community/bots/bot/notifications/server/server", method: "PUT" },
      { path: "/api/community/channels/resolve/members/self?ref=%2FStudio%230042%2Fprivate", method: "DELETE" }])
    await waitFor(() => expect(view.result.current.memberships.data?.servers[0].channels).toEqual([]))
    expect(owner.client.getQueryData<{ servers: Array<{ channels: unknown[] }> }>(communityKeys.botMemberships("bot"))?.servers[0].channels).toEqual([])
    expect(view.result.current.audit.events).toHaveLength(50)
    view.unmount()
  })

  it("retires an owner-only 404 without a refetch loop or a surviving Bot window", async () => {
    const network = backend(false), owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    const before = api.mock.calls.length
    network.ownerMissing = true
    await act(async () => { await view.result.current.marks.refetch() })
    await waitFor(() => expect(view.result.current.marks.isNotFound).toBe(true))
    for (const key of keys.slice(0, -1)) expect(owner.client.getQueryData(key)).toBeUndefined()
    expect(api).toHaveBeenCalledTimes(before + 1)
    expect(view.result.current.admin.channels).toHaveLength(1)
    await save(owner); view.unmount()
    const next = await replace(owner)
    for (const key of keys.slice(0, -1)) expect(next.client.getQueryData(key)).toBeUndefined()
    expect(next.client.getQueryData(keys.at(-1)!)).toBeDefined()
  })

  it("rejects captured old or unknown windows after retirement and retains unrelated history", async () => {
    const network = backend(false), owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    const captured = dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery })
    await act(async () => { await retireBotDirectoryScopes(owner.registry, [{ kind: "bot-server", botId: "bot", id: "server" }]) })
    await owner.writer.persistClient({ timestamp: Date.now() + 10, buster: PERSIST_BUSTER, clientState: captured })
    const stale = await owner.writer.restoreClient()
    expect(stale?.clientState.queries.some(query => query.queryKey[3] === "memberships" || query.queryKey[3] === "notification-settings")).toBe(false)
    expect(stale?.clientState.queries.some(query => query.queryKey[3] === "audit-log")).toBe(true)
    network.offline = false
    await act(async () => { await owner.client.refetchQueries({ predicate: query => isBotDirectoryWindowKey(query.queryKey) }) })
    await waitFor(() => expect(view.result.current.server.confirmed).toBe(true))
    await owner.writer.persistClient({ timestamp: Date.now() + 20, buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
    expect((await owner.writer.restoreClient())?.clientState.queries.some(query => query.queryKey[3] === "notification-settings")).toBe(true)
    await owner.writer.persistClient({ timestamp: Date.now() + 30, buster: PERSIST_BUSTER, clientState: captured })
    expect((await owner.writer.restoreClient())?.clientState.queries.some(query => query.queryKey[3] === "notification-settings")).toBe(false)
    view.unmount()
  })

  it("keeps actual resource deletion permanent and expires old C reads inside a fresh snapshot", async () => {
    backend(false)
    const owner = await seed(), view = mount(owner)
    await loaded(view)
    await act(async () => { await retireBotServerDirectories(owner.registry, "server") })
    await act(async () => { await owner.client.refetchQueries({ predicate: query => isBotDirectoryWindowKey(query.queryKey) }) })
    await save(owner)
    const snapshot = await owner.writer.restoreClient()
    expect(snapshot?.clientState.queries.filter(query => isBotDirectoryWindowKey(query.queryKey)).map(query => JSON.stringify(query.queryKey)).sort())
      .toEqual([communityKeys.botAuditLog("bot"), communityKeys.botAuditPreview("bot")].map(key => JSON.stringify(key)).sort())
    for (const query of owner.client.getQueryCache().getAll()) if (isBotDirectoryWindowKey(query.queryKey)) query.setState({ dataUpdatedAt: Date.now() - PERSIST_MAX_AGE_MS - 1 })
    await save(owner)
    expect((await owner.writer.restoreClient())?.clientState.queries.some(query => isBotDirectoryWindowKey(query.queryKey))).toBe(false)
    view.unmount()
  })

  it("keeps B and C in one twenty-window pool with complete source-owned rows", async () => {
    backend(false)
    let owner = await seed()
    const view = mount(owner)
    await loaded(view)
    let now = Date.now() + 1
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const terms = Array.from({ length: 20 }, (_, index) => `Person-${String(index).padStart(2, "0")}`)
    try {
      for (const term of terms) {
        now += 1
        await act(async () => { await owner.client.query({ queryKey: ["community", "user-search", term], queryFn: ({ client, signal }) => searchCommunityUsers(term, client, { signal }) }) })
      }
      now += 1
      await act(async () => { await view.result.current.marks.refetch() })
      await save(owner); view.unmount(); owner = await replace(owner)
      expect(owner.client.getQueryData(keys[0])).toBeDefined()
      expect(owner.client.getQueryData(["community", "user-search", terms[0]])).toBeUndefined()
      expect(owner.client.getQueriesData({ queryKey: ["community", "user-search"] })).toHaveLength(19)
      expect(owner.client.getQueryCache().getAll().filter(query => isBotDirectoryWindowKey(query.queryKey) || query.queryKey[1] === "user-search")).toHaveLength(20)
      for (const key of keys.slice(1)) expect(owner.client.getQueryData(key)).toBeUndefined()
    } finally { clock.mockRestore() }
  })

  it("does not admit an account's C windows into another owner or a retired account epoch", async () => {
    backend(false)
    const owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    const captured = dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery })
    const otherAccount = `other-${crypto.randomUUID()}`
    accounts.add(otherAccount)
    const other = newOwner(otherAccount)
    await other.writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: captured })
    expect((await other.writer.restoreClient())?.clientState.queries.some(query => isBotDirectoryWindowKey(query.queryKey))).toBe(false)
    await clearPersistedCache(owner.account)
    await owner.writer.persistClient({ timestamp: Date.now() + 1, buster: PERSIST_BUSTER, clientState: captured })
    const next = newOwner(owner.account)
    expect(await next.writer.restoreClient()).toBeUndefined()
    expect(other.client.getQueryData(keys[0])).toBeUndefined()
    view.unmount()
  })

  it("withdraws admin data at the actual role publication and rejects its held response and old disk snapshot", async () => {
    const network = backend(false), owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    const captured = dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery })
    let release!: (value: unknown) => void
    network.admin = new Promise(resolve => { release = resolve })
    const before = api.mock.calls.length
    let pending!: ReturnType<typeof view.result.current.admin.refetch>
    act(() => { pending = view.result.current.admin.refetch() })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(before + 1))
    const signal = api.mock.calls.at(-1)![1].signal as AbortSignal
    const member = [...owner.registry.collections.serverMemberships.values()].find(row => row.serverId === "server" && row.userId === owner.account)!
    await act(async () => {
      await completeCommunityPublication(owner.registry, () => publishCommunityMemberRole(owner.client, member.id, member.memberId, "member", { token: captureCommunityLiveSnapshotToken(owner.client) }))
    })
    expect(signal.aborted).toBe(true)
    expect(owner.client.getQueryData(keys.at(-1)!)).toBeUndefined()
    await act(async () => { release({ channels: [{ id: "late-admin", name: "Late", type: "text", category: null, creator: null, createdAt: date }] }); await pending })
    await waitFor(() => expect(view.result.current.admin.channels).toBeUndefined())
    expect(view.result.current.memberships.data?.servers).toHaveLength(1)
    await owner.writer.persistClient({ timestamp: Date.now() + 1, buster: PERSIST_BUSTER, clientState: captured })
    const snapshot = await owner.writer.restoreClient()
    expect(snapshot?.clientState.queries.some(query => query.queryKey[3] === "admin-channels")).toBe(false)
    expect(snapshot?.clientState.queries.some(query => query.queryKey[3] === "memberships")).toBe(true)
    view.unmount()
  })

  it("does not retire a requalified Bot directory when only the human admin role changes", async () => {
    backend(false)
    const owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    await act(async () => { await retireBotDirectoryScopes(owner.registry, [{ kind: "bot-server", botId: "bot", id: "server" }]) })
    await act(async () => { await owner.client.refetchQueries({ predicate: query => isBotDirectoryWindowKey(query.queryKey) }) })
    await save(owner)
    expect((await owner.writer.restoreClient())?.clientState.queries.filter(query => isBotDirectoryWindowKey(query.queryKey))).toHaveLength(7)
    const member = [...owner.registry.collections.serverMemberships.values()].find(row => row.serverId === "server" && row.userId === owner.account)!
    await act(async () => { await completeCommunityPublication(owner.registry, () => publishCommunityMemberRole(owner.client, member.id, member.memberId, "member", { token: captureCommunityLiveSnapshotToken(owner.client) })) })
    await save(owner)
    const snapshot = await owner.writer.restoreClient()
    for (const key of keys.slice(0, -1)) expect(snapshot?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(true)
    expect(snapshot?.clientState.queries.some(query => query.queryKey[3] === "admin-channels")).toBe(false)
    view.unmount()
  })

  it("does not lend a retained invite's qualification to an invite removed from the stored window", async () => {
    backend(false)
    const owner = await seed(), view = mount(owner)
    await loaded(view)
    const key = communityKeys.invites("server")
    const response = invitesReadFixture("server", ["a", "b"].map(value => ({ id: `invite-${value}`, token: `token-${value}`, creatorId: owner.account,
      uses: 0, maxUses: null, expiresAt: null, createdAt: date })), [profileResourceFixture({ id: owner.account })], owner.account)
    api.mockResolvedValueOnce(response)
    await act(async () => { await owner.client.query({ queryKey: key, queryFn: invitesQueryFn("server") }) })
    await save(owner)
    await owner.registry.retireAuxiliaryDisk([{ kind: "server", id: "server" }])
    api.mockResolvedValueOnce(response)
    await act(async () => { await owner.client.query({ queryKey: key, queryFn: invitesQueryFn("server"), staleTime: 0 }) })
    await save(owner)
    const captured = dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery })
    await owner.registry.retireAuxiliaryDisk([{ kind: "invite", id: "token-a" }])
    await owner.writer.persistClient({ timestamp: Date.now() + 1, buster: PERSIST_BUSTER, clientState: captured })
    const snapshot = await owner.writer.restoreClient()
    const persisted = snapshot?.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(key))?.state.data as { invites: Array<{ code: string }> } | undefined
    expect(persisted?.invites.map(invite => invite.code)).toEqual(["token-b"])
    view.unmount()
  })

  it("withdraws a deleted admin-only child and rejects its held refresh and old disk window", async () => {
    const network = backend(false), owner = await seed(), view = mount(owner)
    await loaded(view); await save(owner)
    const key = communityKeys.adminChannels("server")
    const captured = dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery })
    let release!: (data: unknown) => void
    network.admin = new Promise(resolve => { release = resolve })
    let refresh!: Promise<void>
    await act(async () => { refresh = owner.client.refetchQueries({ queryKey: key, exact: true }) })
    await waitFor(() => expect(owner.client.getQueryState(key)?.fetchStatus).toBe("fetching"))
    await act(async () => { retireCommunityChannelReading(owner.registry, "admin-private", { reason: "resource-deleted", serverId: "server" }) })
    try { expect(owner.client.getQueryData(key)).toBeUndefined() }
    finally { await act(async () => { release({ channels: [{ id: "admin-private", name: "Deleted", type: "forum", category: null, creator: null, createdAt: date }] }); await refresh }) }
    await waitFor(() => expect(view.result.current.admin.channels).toBeUndefined())
    await owner.writer.persistClient({ timestamp: Date.now() + 1, buster: PERSIST_BUSTER, clientState: captured })
    expect((await owner.writer.restoreClient())?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
    expect(owner.client.getQueryData(communityKeys.botMarks("bot"))).toBeDefined()
    view.unmount()
  })

  it("rejects a deleted admin-only child from an unknown in-flight first read", async () => {
    const network = backend(false), owner = await seed()
    let release!: (data: unknown) => void
    network.admin = new Promise(resolve => { release = resolve })
    const view = mount(owner), key = communityKeys.adminChannels("server")
    await waitFor(() => expect(view.result.current.marks.hasData).toBe(true))
    expect(owner.client.getQueryData(key)).toBeUndefined()
    await act(async () => { retireCommunityChannelReading(owner.registry, "admin-private", { reason: "resource-deleted", serverId: "server" }) })
    try { expect(owner.client.getQueryState(key)?.fetchStatus).toBe("idle") }
    finally { await act(async () => { release({ channels: [{ id: "admin-private", name: "Deleted", type: "forum", category: null, creator: null, createdAt: date }] }); await Promise.resolve() }) }
    expect(view.result.current.admin.channels).toBeUndefined()
    await save(owner)
    expect((await owner.writer.restoreClient())?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
    view.unmount()
  })
})

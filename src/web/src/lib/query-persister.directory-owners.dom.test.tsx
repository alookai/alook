import "fake-indexeddb/auto"
import { BUSINESS_SCHEMA_VERSION, CommunityMembersReadSchema } from "@alook/shared"
import { createElement, useEffect, type PropsWithChildren } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient, useQuery } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { channelResourceFixture, friendBucketScenarioFixture, fullResourceBundleFixture, invitesReadFixture, messageResourceFixture, profileResourceFixture, serverMembersReadFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useAddableMembers, useChannelMembers } from "@/hooks/community/use-channel-members"
import { useInvitableFriends } from "@/hooks/community/use-invitable-friends"
import { invitesQueryFn, useInvites } from "@/hooks/community/use-server-panels"
import { useRevokeInvite } from "@/hooks/community/mutations/invites"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { captureCommunityLiveSnapshotToken, completeCommunityPublication, discardCommunityRestoreReplacements, publishCommunityFriendDecision, publishCommunityMemberRemoval, publishCommunityResourceBundle, restoreCommunityCollections, setCanonicalCommunityChannelMember } from "./community-db/sync"
import { serverMembershipKey } from "./community-db/schema"
import { communityKeys } from "./query-keys"
import { searchCommunityUsers } from "./community/user-search"
import { blobKeyFor } from "./persisted-account-identity"
import { cacheStore } from "./query-cache-store"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "./query-persister"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
type Owner = { account: string; client: QueryClient; registry: CommunityDbRegistry }
type Read = { ids: string[]; ready: boolean; failed: boolean; observed: boolean; isCurrentRead?: () => boolean }

afterEach(async () => {
  for (const persister of persisters.splice(0)) persister.stopPersisting()
  for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
  api.mockReset()
})

function useMembersRead(): Read {
  const read = useServerMembers("server")
  return { ids: read.members.map(row => row.userId), ready: read.displayReady, observed: read.observed, failed: read.failed || read.refreshFailed, isCurrentRead: read.isCurrentRead }
}
function useMemberSearchRead(): Read {
  const read = useServerMembers("server")
  const { searchMembers } = read
  useEffect(() => { searchMembers("Person") }, [searchMembers])
  return { ids: read.members.map(row => row.userId), ready: read.displayReady && read.searchQuery === "Person" && read.searchStatus !== "loading", observed: read.observed, failed: read.searchStatus === "error", isCurrentRead: read.isCurrentRead }
}
function useAccessRead(): Read {
  const read = useChannelMembers("parent", true, "server", "access")
  return { ids: read.members.map(row => row.userId), ready: read.data !== undefined, observed: read.observed, failed: read.isError || read.failed, isCurrentRead: read.isCurrentRead }
}
function useNotifyRead(): Read {
  const read = useChannelMembers("thread", true, "server", "notify")
  return { ids: read.members.map(row => row.userId), ready: read.data !== undefined, observed: read.observed, failed: read.isError || read.failed, isCurrentRead: read.isCurrentRead }
}
function useAddableRead(): Read {
  const read = useAddableMembers("server", "parent")
  return { ids: read.members.map(row => row.userId), ready: read.data !== undefined, observed: read.observed, failed: read.isError, isCurrentRead: read.isCurrentRead }
}
function useInvitableRead(): Read {
  const read = useInvitableFriends("server")
  return { ids: read.friends.map(row => row.userId!), ready: read.data !== undefined, observed: read.observed, failed: read.isError, isCurrentRead: read.isCurrentRead }
}
function useInvitesRead(): Read {
  const read = useInvites("server", true)
  return { ids: read.invites.map(row => row.code), ready: read.data !== undefined, observed: read.observed, failed: read.failed || read.refreshFailed, isCurrentRead: read.isCurrentRead }
}
function useUserSearchRead(): Read {
  const read = useQuery({ queryKey: ["community", "user-search", "Person"], queryFn: ({ client, signal }) => searchCommunityUsers("Person", client, { signal }), retry: false })
  return { ids: read.data?.ids ?? [], ready: read.data !== undefined, observed: read.data?.observed === true && !read.isError, failed: read.isError }
}

const cases = [
  { family: "members", empty: false, useRead: useMembersRead, key: communityKeys.members("server") },
  ...[false, true].map(empty => ({ family: "member-search", empty, useRead: useMemberSearchRead, key: [...communityKeys.members("server"), "search", "Person"] })),
  { family: "channel-access", empty: false, useRead: useAccessRead, key: communityKeys.channelMembers("parent", "access") },
  ...[false, true].map(empty => ({ family: "notify", empty, useRead: useNotifyRead, key: communityKeys.channelMembers("thread", "notify") })),
  ...[false, true].map(empty => ({ family: "addable", empty, useRead: useAddableRead, key: communityKeys.channelAddableMembers("parent") })),
  ...[false, true].map(empty => ({ family: "invitable", empty, useRead: useInvitableRead, key: communityKeys.invitableFriends("server") })),
  ...[false, true].map(empty => ({ family: "user-search", empty, useRead: useUserSearchRead, key: ["community", "user-search", "Person"] })),
  ...[false, true].map(empty => ({ family: "invites", empty, useRead: useInvitesRead, key: communityKeys.invites("server") })),
]

async function createOwner(): Promise<Owner> {
  const account = `directory-owner-${crypto.randomUUID()}`
  accounts.add(account)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  owners.add(registry)
  await registry.preload()
  await publishCommunityResourceBundle(client, fullResourceBundleFixture(account,
    [serverResourceFixture({ id: "server", ownerId: account })],
    [channelResourceFixture({ id: "parent", serverId: "server" }), channelResourceFixture({ id: "thread", serverId: "server", type: "thread", parentChannelId: "parent", parentMessageId: "opener" })],
    [messageResourceFixture({ id: "opener", channelId: "parent", authorId: account, authorName: "Owner" })],
    [profileResourceFixture({ id: account, name: "Owner" })]), { token: captureCommunityLiveSnapshotToken(client) })
  return { account, client, registry }
}

async function saveAndReplace(source: Owner): Promise<Owner> {
  const writer = createIdbPersister(source.account)
  persisters.push(writer)
  const before = await get<string>(blobKeyFor(source.account), cacheStore)
  const timestamp = Math.max(Date.now(), before ? JSON.parse(before).timestamp + 1 : 0)
  await writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  const raw = await get<string>(blobKeyFor(source.account), cacheStore)
  expect(JSON.parse(raw!).timestamp).toBe(timestamp)
  writer.stopPersisting()
  return restoreSavedOwner(source)
}

async function restoreSavedOwner(source: Owner): Promise<Owner> {
  await source.registry.cleanup()
  owners.delete(source.registry)
  source.client.clear()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  let release!: () => void
  const registry = createCommunityDbRegistry(client, source.account, { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
  owners.add(registry)
  const reader = createIdbPersister(source.account)
  persisters.push(reader)
  registry.bindAuthentication(() => source.account, reader.retireAccount, reader.retireChannels, reader.retireAuxiliaryScopes)
  const restore = createCommunityRestorePersister(reader, source.account)
  await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(registry, input); registry.captureRestoredCollections(input); registry.runtime.ws.actions.activateProfileAccount(source.account) }
  finally { discardCommunityRestoreReplacements(registry); release() }
  await registry.preload()
  return { account: source.account, client, registry }
}

function configureTransport(source: Owner, family: string, empty: boolean) {
  const member = { id: "member-person", userId: "person", name: "Person", discriminator: "0042", avatar: "P", avatarVersion: 0, role: "member" }
  const viewer = { ...member, id: "member-server", userId: source.account, name: "Owner", role: "owner" }
  let failing = false
  api.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (failing) throw new Error("Sustained directory transport failure")
    if (options?.method === "DELETE" && path === "/api/community/invites/saved-token") return { success: true }
    if (path.startsWith("/api/community/servers/server/members")) {
      const search = new URL(path, "https://fixture.test").searchParams.has("q")
      return serverMembersReadFixture("server", search ? empty ? [] : [member] : [viewer, member], { viewerId: source.account, search, total: 2 })
    }
    if (path.includes("/channels/") && path.includes("/members?")) {
      const notify = path.includes("/thread/")
      const selected = notify ? empty ? [] : [member] : family === "addable" && !empty ? [viewer] : [viewer, member]
      const channelId = notify ? "thread" : "parent"
      return CommunityMembersReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId, relation: notify ? "notify" : "access",
        members: selected.map(row => ({ channelId, userId: row.userId, memberId: row.id, role: row.role, relation: notify ? "notify" : "access", source: notify ? "added" : "explicit", isCreator: row.userId === source.account })),
        profiles: selected.map(row => profileResourceFixture({ id: row.userId, name: row.name })),
      })
    }
    if (path.endsWith("/accepted")) return friendBucketScenarioFixture("friends", empty ? [] : [{ id: "friend-person", userId: "friend-person", name: "Friend", discriminator: "0042", avatar: "F", avatarVersion: 0 }], source.account)
    if (path.endsWith("/blocked")) return friendBucketScenarioFixture("blocked", [], source.account)
    if (path.endsWith("/pending")) return friendBucketScenarioFixture("pending", [], source.account)
    if (path.includes("/users/search?")) return { users: empty ? [] : [{ id: "person", name: "Person", discriminator: "0042", image: null, avatarVersion: 0 }] }
    if (path.endsWith("/invites")) return invitesReadFixture("server", empty ? [] : [{ id: "invite", token: "saved-token", creatorId: "creator", uses: 2, maxUses: null, expiresAt: null, createdAt: "2026-11-01T00:00:00Z" }], empty ? [] : [profileResourceFixture({ id: "creator", name: "Creator" })], source.account)
    throw new Error(`Unexpected directory request: ${path}`)
  })
  return { fail: () => { failing = true } }
}

function mountRead(owner: Owner, useRead: () => Read) {
  return renderHook(useRead, { wrapper: ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children) })
}

describe("actual directory readers across IDB and three independent owners", () => {
  it.each(cases)("retains $family after failed refresh and resave (empty=$empty)", async ({ family, empty, key, useRead }) => {
    const source = await createOwner()
    const transport = configureTransport(source, family, empty)
    const first = mountRead(source, useRead)
    const expected = empty ? [] : family === "members" || family === "channel-access" ? [source.account, "person"] : family === "invites" ? ["saved-token"] : family === "invitable" ? ["friend-person"] : ["person"]
    await waitFor(() => expect(first.result.current).toMatchObject({ ready: true, observed: true, ids: expected }))
    expect(api).toHaveBeenCalled()
    const updatedAt = source.client.getQueryState(key)!.dataUpdatedAt
    first.unmount()
    const second = await saveAndReplace(source)
    expect(second.registry).not.toBe(source.registry)
    expect(second.client).not.toBe(source.client)
    expect(second.client.getQueryData(key)).toBeDefined()
    expect(second.client.getQueryState(key)).toMatchObject({ dataUpdatedAt: updatedAt, isInvalidated: true })
    transport.fail()
    const readsBeforeFailure = api.mock.calls.length
    const current = mountRead(second, useRead)
    await waitFor(() => expect(current.result.current).toMatchObject({ ready: true, observed: false, failed: true, ids: expected }))
    expect(api.mock.calls.length).toBeGreaterThan(readsBeforeFailure)
    expect(second.client.getQueryState(key)).toMatchObject({ status: "error", dataUpdatedAt: updatedAt })
    if (family !== "user-search") expect(current.result.current.isCurrentRead!()).toBe(false)
    current.unmount()
    const third = await saveAndReplace(second)
    expect(third.registry).not.toBe(second.registry)
    expect(third.client.getQueryData(key)).toBeDefined()
    expect(third.client.getQueryState(key)).toMatchObject({ dataUpdatedAt: updatedAt, isInvalidated: true, fetchStatus: "idle" })
    const last = mountRead(third, useRead)
    await waitFor(() => expect(last.result.current).toMatchObject({ ready: true, observed: false, failed: true, ids: expected }))
    await act(async () => { last.unmount() })
  })
})

describe("authoritative directory retirement before a late old IDB write", () => {
  it.each([
    { family: "members", useRead: useMembersRead, key: communityKeys.members("server") },
    { family: "notify", useRead: useNotifyRead, key: communityKeys.channelMembers("thread", "notify") },
    { family: "invitable", useRead: useInvitableRead, key: communityKeys.invitableFriends("server") },
    { family: "invites", useRead: useInvitesRead, key: communityKeys.invites("server") },
  ])("keeps a retired $family dependency out of an old snapshot without dropping another window", async ({ family, useRead, key }) => {
    const source = await createOwner()
    configureTransport(source, family, false)
    const view = mountRead(source, useRead)
    const expected = family === "members" ? [source.account, "person"] : family === "invitable" ? ["friend-person"] : family === "invites" ? ["saved-token"] : ["person"]
    await waitFor(() => expect(view.result.current).toMatchObject({ ids: expected, ready: true, observed: true }))
    view.unmount()
    const keepKey = ["community", "user-search", "Person"]
    await source.client.query({ queryKey: keepKey, queryFn: ({ client, signal }) => searchCommunityUsers("Person", client, { signal }) })
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    const retired: Promise<void>[] = []
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, scopes => {
      const operation = writer.retireAuxiliaryScopes(scopes)
      retired.push(operation)
      return operation
    })
    const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
    await writer.persistClient(snapshot)
    if (family === "members") await completeCommunityPublication(source.registry, () => publishCommunityMemberRemoval(source.client, serverMembershipKey("server", "person"), "member-person", { token: captureCommunityLiveSnapshotToken(source.client) }))
    else if (family === "notify") await completeCommunityPublication(source.registry, () => setCanonicalCommunityChannelMember(source.client, "thread", "person", "notify", false, { event: true }))
    else if (family === "invitable") await completeCommunityPublication(source.registry, () => publishCommunityFriendDecision(source.client, "friend-person", "remove", { token: captureCommunityLiveSnapshotToken(source.client) }))
    else {
      const mutation = renderHook(() => useRevokeInvite(), { wrapper: ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: source.client, registry: source.registry, retainOwner: true }, children) })
      const capturedRevoke = mutation.result.current.mutateAsync
      await act(async () => { await source.client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" }) })
      const beforeRejectedAction = api.mock.calls.length
      await act(async () => { await expect(capturedRevoke({ serverId: "server", code: "saved-token" })).rejects.toMatchObject({ name: "AbortError" }) })
      expect(api.mock.calls.length).toBe(beforeRejectedAction)
      await source.client.query({ queryKey: key, queryFn: invitesQueryFn("server"), staleTime: 0 })
      await act(async () => { await capturedRevoke({ serverId: "server", code: "saved-token" }) })
      expect(api).toHaveBeenCalledWith("/api/community/invites/saved-token", expect.objectContaining({ method: "DELETE" }))
      mutation.unmount()
    }
    await Promise.all(retired)
    expect(retired.length).toBeGreaterThan(0)
    await writer.persistClient({ ...snapshot, timestamp: snapshot.timestamp + 1 })
    writer.stopPersisting()
    const second = await restoreSavedOwner(source)
    expect(second.client.getQueryData(keepKey)).toMatchObject({ ids: ["person"] })
    if (family === "invites") expect(second.client.getQueryData(key)).toMatchObject({ invites: [] })
    else expect(second.client.getQueryData(key)).toBeUndefined()
  })
})

describe("fresh native read after auxiliary retirement", () => {
  it.each([false, true])("persists a newly successful re-added notify roster with replacementWriter=%s", async replacementWriter => {
    const source = await createOwner()
    configureTransport(source, "notify", false)
    const key = communityKeys.channelMembers("thread", "notify")
    const view = mountRead(source, useNotifyRead)
    try {
    await waitFor(() => expect(view.result.current).toMatchObject({ ids: ["person"], ready: true, observed: true }))
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    const retirements: Promise<void>[] = []
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, scopes => {
      const operation = writer.retireAuxiliaryScopes(scopes); retirements.push(operation); return operation
    }, writer.captureAuxiliaryReadEpoch)
    const snapshot = () => ({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
    const keepKey = ["community", "user-search", "Person"]
    await source.client.query({ queryKey: keepKey, queryFn: ({ client, signal }) => searchCommunityUsers("Person", client, { signal }) })
    const capturedBeforeRemoval = JSON.parse(JSON.stringify(snapshot()))
    await writer.persistClient(capturedBeforeRemoval)
    await act(async () => { await completeCommunityPublication(source.registry, () => setCanonicalCommunityChannelMember(source.client, "thread", "person", "notify", false, { event: true })) })
    await Promise.all(retirements)
    expect(retirements.length).toBeGreaterThan(0)
    const beforeRead = api.mock.calls.length
    await act(async () => { await source.client.refetchQueries({ queryKey: key, exact: true }) })
    await waitFor(() => expect(view.result.current).toMatchObject({ ids: ["person"], ready: true, observed: true }))
    expect(api.mock.calls.length).toBeGreaterThan(beforeRead)
    expect(source.registry.collections.channelMemberships.has("thread:person:notify")).toBe(true)
    const finalWriter = replacementWriter ? createIdbPersister(source.account) : writer
    if (replacementWriter) persisters.push(finalWriter)
    await finalWriter.persistClient(snapshot())
    const raw = await get<string>(blobKeyFor(source.account), cacheStore)
    const disk = JSON.parse(raw!)
    expect(disk.clientState.queries.find((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))?.state.data).toMatchObject({ relation: "notify", members: [{ id: "member-person", userId: "person" }], observed: false })
    if (!replacementWriter) {
      await writer.persistClient({ ...capturedBeforeRemoval, timestamp: Date.now() + 1 })
      const oldDisk = JSON.parse((await get<string>(blobKeyFor(source.account), cacheStore))!)
      expect(oldDisk.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
      expect(oldDisk.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(keepKey))).toBe(true)
      const fresh = JSON.parse(JSON.stringify(snapshot()))
      await writer.persistClient(fresh)
      let queuedFinished = false
      const queued = Promise.resolve(writer.persistClient({ ...fresh, timestamp: Date.now() + 2 })).then(() => { queuedFinished = true })
      expect(queuedFinished).toBe(false)
      await act(async () => { await completeCommunityPublication(source.registry, () => setCanonicalCommunityChannelMember(source.client, "thread", "person", "notify", false, { event: true })) })
      await Promise.all(retirements)
      expect(queuedFinished).toBe(false)
      await queued
      const queuedDisk = JSON.parse((await get<string>(blobKeyFor(source.account), cacheStore))!)
      expect(queuedDisk.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
      expect(queuedDisk.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(keepKey))).toBe(true)
      api.mockRejectedValueOnce(new Error("New generation read failed"))
      await act(async () => { await source.client.refetchQueries({ queryKey: key, exact: true }) })
      expect(source.client.getQueryState(key)?.status).toBe("error")
      await writer.persistClient(snapshot())
      const failedDisk = JSON.parse((await get<string>(blobKeyFor(source.account), cacheStore))!)
      expect(failedDisk.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
      await act(async () => { await source.client.refetchQueries({ queryKey: key, exact: true }) })
      await waitFor(() => expect(view.result.current).toMatchObject({ ids: ["person"], ready: true, observed: true }))
      await writer.persistClient(snapshot())
      view.unmount()
      writer.stopPersisting()
      const second = await restoreSavedOwner(source)
      expect(second.client.getQueryData(key)).toMatchObject({ members: [{ userId: "person" }], observed: false })
      expect(second.client.getQueryData(keepKey)).toMatchObject({ ids: ["person"], observed: false })
    }
    } finally { view.unmount() }
  })
})

describe("auxiliary read proof at the real request boundary", () => {
  it("does not borrow a later generation for a request that started before removal", async () => {
    const source = await createOwner()
    configureTransport(source, "notify", false)
    const key = communityKeys.channelMembers("thread", "notify")
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    const operations: Promise<void>[] = []
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, scopes => {
      const operation = writer.retireAuxiliaryScopes(scopes); operations.push(operation); return operation
    }, writer.captureAuxiliaryReadEpoch)
    const view = mountRead(source, useNotifyRead)
    try {
      await waitFor(() => expect(view.result.current).toMatchObject({ ids: ["person"], ready: true, observed: true }))
      const response = await api.mock.results.at(-1)!.value
      const save = () => writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
      await save()
      let release!: (response: unknown) => void
      const gate = new Promise(resolve => { release = resolve })
      api.mockImplementationOnce(() => gate)
      const before = api.mock.calls.length
      const pending = source.client.refetchQueries({ queryKey: key, exact: true })
      await waitFor(() => expect(api.mock.calls.length).toBe(before + 1))
      await act(async () => { await completeCommunityPublication(source.registry, () => setCanonicalCommunityChannelMember(source.client, "thread", "person", "notify", false, { event: true })) })
      await Promise.all(operations)
      await act(async () => { release(response); await pending })
      await save()
      const stored = JSON.parse((await get<string>(blobKeyFor(source.account), cacheStore))!)
      expect(stored.clientState.queries.some((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
      await act(async () => { await source.client.refetchQueries({ queryKey: key, exact: true }) })
      await waitFor(() => expect(view.result.current).toMatchObject({ ids: ["person"], ready: true, observed: true }))
      await save()
      const fresh = JSON.parse((await get<string>(blobKeyFor(source.account), cacheStore))!)
      expect(fresh.clientState.queries.find((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))?.state.data).toMatchObject({ members: [{ userId: "person" }], observed: false })
    } finally { view.unmount() }
  })
})

describe("composed directory reads after same-writer retirement", () => {
  it.each([
    { family: "members", useRead: useMembersRead, key: communityKeys.members("server") },
    { family: "addable", useRead: useAddableRead, key: communityKeys.channelAddableMembers("parent") },
    { family: "invitable", useRead: useInvitableRead, key: communityKeys.invitableFriends("server") },
  ])("saves a fresh $family read without reusing a pre-removal constituent", async ({ family, useRead, key }) => {
    const source = await createOwner()
    configureTransport(source, family, false)
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    const operations: Promise<void>[] = []
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, scopes => {
      const operation = writer.retireAuxiliaryScopes(scopes); operations.push(operation); return operation
    }, writer.captureAuxiliaryReadEpoch)
    const expected = family === "members" ? [source.account, "person"] : family === "invitable" ? ["friend-person"] : ["person"]
    const view = mountRead(source, useRead)
    try {
      await waitFor(() => expect(view.result.current).toMatchObject({ ids: expected, ready: true, observed: true }))
      const save = () => writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
      await save()
      await act(async () => { await completeCommunityPublication(source.registry, () => family === "invitable"
        ? publishCommunityFriendDecision(source.client, "friend-person", "remove", { token: captureCommunityLiveSnapshotToken(source.client) })
        : publishCommunityMemberRemoval(source.client, serverMembershipKey("server", "person"), "member-person", { token: captureCommunityLiveSnapshotToken(source.client) })) })
      await Promise.all(operations)
      const before = api.mock.calls.length
      await act(async () => { await source.client.refetchQueries({ queryKey: key, exact: true }) })
      await waitFor(() => expect(view.result.current).toMatchObject({ ids: expected, ready: true, observed: true }))
      const newReads = api.mock.calls.slice(before).map(([path]) => path as string)
      expect(newReads.some(path => path.startsWith("/api/community/servers/server/members"))).toBe(true)
      if (family === "addable") expect(newReads.some(path => path.includes("/channels/parent/members?"))).toBe(true)
      if (family === "invitable") expect(newReads.some(path => path.endsWith("/accepted"))).toBe(true)
      await save()
      view.unmount()
      writer.stopPersisting()
      const second = await restoreSavedOwner(source)
      expect(second.client.getQueryData(key)).toBeDefined()
      const read = mountRead(second, useRead)
      try { await waitFor(() => expect(read.result.current).toMatchObject({ ids: expected, ready: true })) }
      finally { read.unmount() }
    } finally { view.unmount() }
  })
})

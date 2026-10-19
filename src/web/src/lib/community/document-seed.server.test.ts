import { useMessage } from "@/hooks/community/use-message"
import { useBots } from "@/hooks/community/use-bots"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@alook/shared"
import { conversationEntryFixture, conversationEntryTarget, forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useCanonicalCommunityProfile, useMessageWindowProjection, useRouteChannelProjection } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { installCommunityDocumentSeed } from "./document-seed"
import { conversationEntryOptions } from "./conversation-entry"
import { eq, getLiveQueryHash } from "@tanstack/react-db"
import { communityProjection } from "@/lib/community-db/live-query"
import { communityCollectionQuery } from "@/lib/community-db/queries"
import { useForumFeed } from "@/hooks/community/use-forum-feed"
import { useServerTreeProjection } from "@/lib/community-db/projections"

const mocks = vi.hoisted(() => ({ door: vi.fn(), entry: vi.fn(), bots: vi.fn(), machines: vi.fn(), server: vi.fn() }))
vi.mock("./message-door", () => ({ resolveMessageTarget: mocks.door }))
vi.mock("./conversation-entry.server", () => ({ readCommunityConversationEntry: mocks.entry }))
vi.mock("./bots.server", () => ({ readCommunityBots: mocks.bots }))
vi.mock("./machines.server", () => ({ readCommunityMachineList: mocks.machines }))
vi.mock("./server-directory.server", () => ({ readCommunityServerDirectory: mocks.server }))
vi.mock("@/hooks/community/use-channel-panels", () => ({ useForumTags: () => ({ data: { tags: [] }, isSuccess: true }) }))
import { readCommunityDocumentSeed } from "./document-seed.server"

export const selfProfile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 7, aboutMe: "About", bannerColor: null, statusEmoji: null, statusText: "Available" }
const db = {} as Database

beforeEach(() => {
  mocks.door.mockReset().mockResolvedValue({ ok: true, value: { access: { channel: { serverId: "s1" } } } })
  mocks.entry.mockReset().mockResolvedValue({ ok: true, entry: conversationEntryFixture() })
  mocks.bots.mockReset().mockResolvedValue({ bots: [], plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, activeCount: 0 })
  mocks.machines.mockReset().mockResolvedValue({ machines: [] })
  mocks.server.mockReset().mockResolvedValue({ id: "s1", name: "Server", discriminator: "0042", description: "", ownerId: "viewer", icon: null, categories: [{ id: "cat", name: "Category", private: false, channels: [{ id: "c1", type: "text", name: "Channel", active: false, unread: false }] }] })
})

function Probe() {
  const self = useCanonicalCommunityProfile("viewer")
  const channel = useRouteChannelProjection("c1")
  const messages = useMessageWindowProjection("c1", ["m1"], [])
  return createElement("span", null, `${self?.name}:${channel?.name}:${messages.messages?.[0]?.content}`)
}

describe("document resource handoff", () => {
  it.each(["forum", "server"])("renders the actual %s projection from its document snapshot while source restore is pending", async kind => {
    if (kind === "forum") mocks.entry.mockResolvedValue({ ok: true, entry: forumConversationEntryFixture() })
    const seed = await readCommunityDocumentSeed(db, "viewer", kind === "forum" ? "/c/channels/s1/c1" : "/c/channels/s1", selfProfile)
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    let release!: () => void
    const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
    installCommunityDocumentSeed(client, registry, seed, "viewer")
    function Forum() { const feed = useForumFeed("s1", "c1"); return createElement("span", null, feed.posts.map(post => post.name).join("|")) }
    function Server() { const tree = useServerTreeProjection("s1"); return createElement("span", null, `${tree?.name}:${tree?.categories[0]?.channels[0]?.name}`) }
    try {
      const html = renderToString(createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, createElement(kind === "forum" ? Forum : Server))))
      expect(html).toBe(kind === "forum" ? "<span>Body</span>" : "<span>Server:Channel</span>")
      if (kind === "server") expect(mocks.server).toHaveBeenCalledWith(db, "viewer", "s1")
    } finally { release(); await registry.preload(); await registry.cleanup(); client.clear() }
  })
  it.each(["bots", "machines"])("loads the opened %s list and its view dependencies through shared loaders", async kind => {
    const seed = await readCommunityDocumentSeed(db, "viewer", `/c/me/${kind}`, selfProfile)
    expect(mocks[kind]).toHaveBeenCalledWith(db, "viewer")
    if (kind === "bots") expect(mocks.machines).toHaveBeenCalledWith(db, "viewer")
    else expect(mocks.bots).not.toHaveBeenCalled()
    expect(mocks.door).not.toHaveBeenCalled()
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, "viewer")
    installCommunityDocumentSeed(client, registry, seed, "viewer")
    expect(client.getQueryData(kind === "bots" ? communityKeys.bots() : communityKeys.machines())).toMatchObject({ [kind]: [] })
    await registry.cleanup()
    client.clear()
  })
  it.each(["matching", "missing", "mismatched"])("isolates %s native live-query snapshots with empty client sources and no canonical installer", async mode => {
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/s1/c1", selfProfile)
    const state = { collections: [], liveQueries: mode === "missing" ? [] : seed.db.liveQueries?.map(query => ({ ...query, queryHash: mode === "mismatched" ? `wrong:${query.queryHash}` : query.queryHash })) }
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    let release!: () => void
    const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
    registry.dbClient.hydrate(state)
    try {
      expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "profiles"))).toBeUndefined()
      expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "channels"))).toBeUndefined()
      expect(client.getQueryData(communityKeys.communityDbCollection("viewer", "messages"))).toBeUndefined()
      expect(registry.collections.profiles.size).toBe(0)
      expect(registry.collections.channels.size).toBe(0)
      expect(registry.collections.messages.size).toBe(0)
      const html = renderToString(createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, createElement(Probe))))
      expect(html).toBe(mode === "matching" ? "<span>Viewer:Channel:Body</span>" : "<span>undefined:undefined:undefined</span>")
      expect(registry.collections.profiles.size).toBe(0)
      expect(registry.collections.channels.size).toBe(0)
      expect(registry.collections.messages.size).toBe(0)
    } finally {
      release()
      await registry.preload()
      await registry.cleanup()
      client.clear()
    }
  })
  it("serializes resolved native snapshots before server cleanup and renders real canonical hooks before disk restore", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/s1/c1", selfProfile)
    expect(seed.db.collections).toEqual([])
    expect(seed.db.liveQueries?.length).toBeGreaterThan(0)
    expect(mocks.door).toHaveBeenCalledWith(db, "viewer", { id: "c1" }, "human", "read")
    let release!: () => void
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
    try {
      expect(installCommunityDocumentSeed(client, registry, JSON.parse(JSON.stringify(seed)), "viewer")).toBe(true)
      const view = communityProjection(registry, communityCollectionQuery(registry, "profiles", ({ row }) => eq(row.id, "viewer")))!
      expect(seed.db.liveQueries?.find(query => query.queryHash === getLiveQueryHash(view.collection))?.snapshot?.rows).toEqual([expect.objectContaining({ value: expect.objectContaining({ name: "Viewer" }) })])
      const resource = client.getQueryData(conversationEntryOptions(client, conversationEntryTarget).queryKey)
      expect(resource).toBeDefined()
      expect(client.getQueryData(communityKeys.selfProfile())).toEqual({ id: "viewer" })
      const html = renderToString(createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, createElement(Probe))))
      expect(html).toBe("<span>Viewer:Channel:Body</span>")
    } finally {
      release()
      await registry.preload()
      await registry.cleanup()
      client.clear()
      const captured = errors.mock.calls
      errors.mockRestore()
      expect(captured).toEqual([])
    }
  })

  it.each(["other", null])("rejects a seed before native hydrate for current session %s", async viewer => {
    const seed = await readCommunityDocumentSeed(db, "viewer", null, selfProfile)
    const client = new QueryClient()
    const registry = createCommunityDbRegistry(client, "viewer")
    const hydrate = vi.spyOn(registry.dbClient, "hydrate")
    expect(installCommunityDocumentSeed(client, registry, seed, viewer)).toBe(false)
    expect(hydrate).not.toHaveBeenCalled()
    expect(client.getQueryData(communityKeys.selfProfile())).toBeUndefined()
    await registry.cleanup()
    client.clear()
  })

  it.each([403, 404])("does not serialize denied conversation data (%s)", async status => {
    mocks.door.mockResolvedValue({ ok: false, status, error: "denied" })
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/s1/c1", selfProfile)
    expect(seed.entries).toEqual([])
    expect(mocks.entry).not.toHaveBeenCalled()
    expect(JSON.stringify(seed)).not.toContain("Body")
  })

  it("preserves the authenticated self seed when only the target prefetch fails", async () => {
    mocks.entry.mockRejectedValue(new Error("temporary read failure"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/s1/c1", selfProfile)
      expect(seed.selfProfile).toEqual(selfProfile)
      expect(seed.entries).toEqual([])
      expect(JSON.stringify(seed)).not.toContain("Body")
      expect(warn).toHaveBeenCalledWith("[community] document resource prefetch unavailable", { kind: "server-conversation", phase: "read-entry", channelId: "c1", generatedAt: seed.generatedAt })
    } finally { warn.mockRestore() }
  })

  it.each(["resolve-target", "read-entry", "read-module"] as const)("correlates %s failures without logging private error material", async phase => {
    const privateError = new Error("session=private-credential; query=private-body")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.door.mockResolvedValue({ ok: true, value: { access: { channel: { serverId: null } } } })
    if (phase === "resolve-target") mocks.door.mockRejectedValue(privateError)
    if (phase === "read-entry") mocks.entry.mockRejectedValue(privateError)
    if (phase === "read-module") mocks.machines.mockRejectedValue(privateError)
    try {
      const seed = await readCommunityDocumentSeed(db, "viewer", phase === "read-module" ? "/c/me/machines" : "/c/me/dm?msg=private-anchor", selfProfile)
      expect(seed.selfProfile).toEqual(selfProfile)
      expect(seed.entries).toEqual([])
      expect(warn).toHaveBeenCalledExactlyOnceWith("[community] document resource prefetch unavailable", {
        kind: phase === "read-module" ? "machines" : "dm", phase,
        channelId: phase === "read-module" ? null : "dm", generatedAt: seed.generatedAt,
      })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|session=|query=/)
      if (phase === "resolve-target") expect(mocks.entry).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it("seeds the child identity and opener without waiting for the independent parent window", async () => {
    const entry = conversationEntryFixture()
    entry.channel = { ...entry.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    entry.surfaceReceipt.surfaceKind = "thread"
    entry.parent = { ...entry.channel, id: "parent", type: "text", parentChannelId: null, parentMessageId: null }
    entry.opener = { ...entry.messages[0], id: "opener", channelId: "parent" }
    mocks.entry.mockResolvedValue({ ok: true, entry })
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/s1/c1", selfProfile)
    expect(seed.entries).toHaveLength(1)
    expect(seed.entries[0].data.opener?.id).toBe("opener")
    expect(mocks.entry).toHaveBeenCalledOnce()
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    let release!: () => void
    const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
    installCommunityDocumentSeed(client, registry, seed, "viewer")
    function ChildContext() {
      const parent = useRouteChannelProjection("parent"), opener = useMessage("opener", { serverId: "s1" })
      return createElement("span", null, `${parent?.name}:${opener.message?.content}`)
    }
    try {
      expect(renderToString(createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, createElement(ChildContext))))).toContain("Channel:Body")
    } finally { release(); await registry.ready; await registry.cleanup(); client.clear() }
  })

  it("renders a populated bots list through the actual hook before source restore", async () => {
    mocks.bots.mockResolvedValue({ bots: [{ id: "bot", name: "Canonical bot", description: "About", image: null, avatarVersion: 3, machineId: "machine", runtime: "codex", modelName: null, reasoningEffort: null, runtimeConfigRevision: 1, isActive: true, presence: "online" }], plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 1, activeCount: 1 })
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/me/bots", selfProfile)
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
    let release!: () => void
    const registry = createCommunityDbRegistry(client, "viewer", { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
    installCommunityDocumentSeed(client, registry, seed, "viewer")
    function Bots() { const view = useBots(); return createElement("span", null, `${view.bots[0]?.name}:${view.profilesPending}:${view.data?.source}`) }
    try {
      expect(renderToString(createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, createElement(Bots))))).toContain("Canonical bot:false:rsc")
    } finally { release(); await registry.ready; await registry.cleanup(); client.clear() }
  })

  it("uses the authorized server scope rather than trusting the route selector", async () => {
    const seed = await readCommunityDocumentSeed(db, "viewer", "/c/channels/foreign/c1", selfProfile)
    expect(seed.entries).toEqual([])
    expect(mocks.entry).not.toHaveBeenCalled()
  })
})

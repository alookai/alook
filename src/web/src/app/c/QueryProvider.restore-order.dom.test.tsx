import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { useLayoutEffect, useRef } from "react"
import {
  dehydrate,
  QueryClient,
  useQueryClient,
} from "@tanstack/react-query"
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, shouldPersistQuery } from "@/lib/query-persister"
import { createCommunityDbRegistry, getCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestServerDetail, ingestServers, ingestMessages, reconcileCommunityRestore, publishCommunityChannelMetadata, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { dispatchCommunityWsEvents } from "@/hooks/community/community-ws/registry"
import type { CommunityWsEvent } from "@alook/shared"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { fetchChannelMetadata } from "@/hooks/community/channel-metadata"
import { useMessages } from "@/hooks/community/use-messages"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useServer, serverProjectedQueryFn } from "@/hooks/community/use-servers"
import { ChannelSidebarScope } from "@/components/community/channels/channel-sidebar-tree-owner"
import { ApiError } from "@/lib/errors"
import { get } from "idb-keyval"
import { tid } from "@/lib/community/testids"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import {
  useRouteChannelProjection,
  useCanonicalMessagesById,
  useDmProjection,
  useTrustedRestoredPrimary,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const persister = vi.hoisted(() => ({
  persistClient: vi.fn(() => Promise.resolve()),
  restoreClient: vi.fn(),
  removeClient: vi.fn(() => Promise.resolve()),
}))

const persistenceIo = vi.hoisted(() => ({
  actual: false,
  holdRead: false,
  readReady: null as (() => void) | null,
  releaseRead: null as (() => void) | null,
  reads: [] as Array<{ at: number; value: unknown }>,
  documentAuthority: false,
  commits: [] as Array<{ key: unknown; at: number; value: unknown }>,
}))

vi.mock("@/hooks/community/use-servers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/community/use-servers")>()
  return { ...actual, qualifyRestoredCommunityScopes: async (...args: Parameters<typeof actual.qualifyRestoredCommunityScopes>) => {
    if (persistenceIo.documentAuthority) return actual.qualifyRestoredCommunityScopes(...args)
    const [, accountId, snapshot] = args
    const rows = (name: string) => snapshot.queries.find((query) => query.queryKey.length === 4
      && query.queryKey[0] === "community" && query.queryKey[1] === "db"
      && query.queryKey[2] === accountId && query.queryKey[3] === name)?.state.data as Array<{ id: string }> | undefined
    reconcileCommunityRestore(args[0], accountId, snapshot)
    const registry = getCommunityDbRegistry(args[0])
    for (const server of rows("servers") ?? []) registry?.settleRestoredScope({ kind: "server", id: server.id,
      channelIds: (rows("channels") ?? []).map((row) => row.id) })
    registry?.settleRestoredScope({ kind: "dms", channelIds: (rows("channels") ?? []).map((row) => row.id) })
  } }
})

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>()
  return {
    ...actual,
    set: async (...args: Parameters<typeof actual.set>) => {
      await actual.set(...args)
      persistenceIo.commits.push({ key: args[0], at: Date.now(), value: args[1] })
    },
    get: async (...args: Parameters<typeof actual.get>) => {
      const value = await actual.get(...args)
      if (persistenceIo.actual && persistenceIo.holdRead) {
        persistenceIo.reads.push({ at: Date.now(), value })
        persistenceIo.readReady?.()
        await new Promise<void>((resolve) => { persistenceIo.releaseRead = resolve })
      }
      return value
    },
  }
})

vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/query-persister", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-persister")>()
  return {
    ...actual,
    createIdbPersister: vi.fn((userId: string | null) => persistenceIo.actual
      ? actual.createIdbPersister(userId)
      : persister as Persister),
  }
})

import { QueryProvider } from "./QueryProvider"

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockImplementation(() => new Promise(() => {}))
  persister.persistClient.mockClear()
  persister.restoreClient.mockReset()
  persister.removeClient.mockClear()
  persistenceIo.actual = false
  persistenceIo.holdRead = false
  persistenceIo.readReady = null
  persistenceIo.releaseRead = null
  persistenceIo.reads = []
  persistenceIo.documentAuthority = false
  persistenceIo.commits = []
})

describe("installed persistence through pending Provider and structural WS", () => {
  it.each(["no-ws", "missing-patch", "partial-create", "delete"] as const)(
    "preserves the target closure through actual storage restore: %s",
    async (scenario) => {
      const viewerId = `causal-provider-${scenario}`
      persistenceIo.actual = true
      await clearPersistedCache(viewerId)
      useCommunityWsStore.getState().activateProfileAccount(viewerId)
      const seed = new QueryClient()
      const seedRegistry = createCommunityDbRegistry(seed, viewerId)
      await seedRegistry.preload()
      ingestServers(seedRegistry, { servers: [{ id: "target", name: "Target", initial: "T",
        active: false, unread: false, mentions: 0, ownerId: viewerId }] })
      ingestServerDetail(seedRegistry, {
        id: "target", name: "Target", discriminator: "0001", description: "", icon: null, ownerId: viewerId,
        categories: [{ id: "category", name: "old category", channels: [
          { id: "leaf", name: "old leaf", type: "text", active: false, unread: false },
          { id: "sibling", name: "sibling", type: "forum", active: false, unread: false },
        ] }],
      })
      const persistedUpdatedAt = Date.now() - 60_000
      for (const query of seed.getQueryCache().getAll()) query.setState({ dataUpdatedAt: persistedUpdatedAt })
      await createIdbPersister(viewerId).persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER,
        clientState: dehydrate(seed) })
      const disposeSeedRegistry = seedRegistry.cleanup
      await disposeSeedRegistry()
      seed.clear()

      const readReady = new Promise<void>((resolve) => { persistenceIo.readReady = resolve })
      persistenceIo.holdRead = true
      const commits: Array<{ at: number; ready: boolean; leaf?: string; category?: string; ids: string[] }> = []
      let client!: QueryClient
      let db!: ReturnType<typeof createCommunityDbRegistry>
      function Target() {
        client = useQueryClient()
        db = useOptionalCommunityDbRegistry()!
        const { server } = useServer("target")
        useLayoutEffect(() => {
          commits.push({ at: Date.now(), ready: server !== null,
            leaf: server?.categories.flatMap((category) => category.channels).find((row) => row.id === "leaf")?.name,
            category: server?.categories.find((row) => row.id === "category")?.name,
            ids: server?.categories.flatMap((category) => category.channels).map((row) => row.id) ?? [] })
        })
        return <output data-testid={`causal-${scenario}`}>{server?.categories.flatMap((category) => category.channels)
          .map((row) => `${row.id}:${row.name}`).join("|") ?? "pending"}</output>
      }
      const mounted = render(<QueryProvider userId={viewerId}>
        <CurrentUserProvider initialUser={{ id: viewerId, name: "Viewer", email: "viewer@example.test", avatar: "V", avatarVersion: 0 }}>
          <Target />
        </CurrentUserProvider>
      </QueryProvider>)
      const snapshots: unknown[] = []
      const sample = (phase: string) => {
        snapshots.push({ phase, at: Date.now(), collections: ["servers", "categories", "channels"].map((name) => {
          const state = client.getQueryState(communityKeys.communityDbCollection(viewerId, name))
          const collection = db.collections[name as "servers" | "categories" | "channels"]
          return { name, data: state?.data, dataUpdatedAt: state?.dataUpdatedAt, queryStatus: state?.status,
            collectionStatus: collection.status, rows: [...collection.values()] }
        }) })
      }
      try {
        await waitFor(() => expect(persistenceIo.releaseRead).not.toBeNull())
        await readReady
        sample("actual-get-held-before-hydrate")
        expect(commits.every((commit) => !commit.ready)).toBe(true)
        const events: CommunityWsEvent[] = scenario === "missing-patch" ? [
          { type: "community:channel.update", serverId: "target", channelId: "leaf", changes: { name: "new leaf" } },
          { type: "community:category.update", serverId: "target", categoryId: "category", changes: { name: "new category" } },
        ] as CommunityWsEvent[] : scenario === "partial-create" ? [
          { type: "community:channel.create", serverId: "target", channel: { id: "new-leaf", name: "new leaf",
            type: "text", categoryId: "category", position: 2, createdAt: "2026-01-01T00:00:00.000Z" } },
        ] as CommunityWsEvent[] : scenario === "delete" ? [
          { type: "community:channel.delete", serverId: "target", channelId: "leaf" },
        ] as CommunityWsEvent[] : []
        act(() => dispatchCommunityWsEvents(events, {
          deliveryMode: "batch", queryClient: client,
          communityStore: useCommunityStore.getState(), wsStore: useCommunityWsStore.getState(),
          sub: { channelId: "leaf" }, viewerUserIdRef: { current: viewerId },
          matchesFocus: (event) => event.channelId === "leaf", scheduleInboxInvalidate: vi.fn(),
        }))
        sample("after-existing-ws-dispatch-before-hydrate")
        persistenceIo.holdRead = false
        await act(async () => { persistenceIo.releaseRead?.() })
        await act(async () => { await db.preload() })
        sample("after-hydrate-and-collection-preload")
        const final = commits.at(-1)
        const evidenceDir = resolve(process.env.ALOOK_CAUSAL_EVIDENCE_DIR ?? "../../plans/pr854-causal-controls/diagnostics")
        mkdirSync(evidenceDir, { recursive: true })
        writeFileSync(resolve(evidenceDir, `pr854_causal_provider-${scenario}.json`), JSON.stringify({ scenario, persistedUpdatedAt,
          getReturnedAt: persistenceIo.reads.map((read) => read.at), events, snapshots, commits }, null, 2) + "\n")
        expect.soft(final?.ready).toBe(true)
        expect.soft(final?.ids).toContain("sibling")
        if (scenario === "delete") expect.soft(final?.ids).not.toContain("leaf")
        else expect.soft(final?.ids).toContain("leaf")
        if (scenario === "missing-patch") {
          expect.soft(final?.leaf).toBe("new leaf")
          expect.soft(final?.category).toBe("new category")
        }
        if (scenario === "partial-create") expect.soft(final?.ids).toContain("new-leaf")
      } finally {
        persistenceIo.holdRead = false
        persistenceIo.releaseRead?.()
        act(() => mounted.unmount())
        await client.cancelQueries()
        const disposeRegistry = db.cleanup
        await disposeRegistry()
        client.clear()
        await clearPersistedCache(viewerId)
        persistenceIo.actual = false
      }
    },
  )
})

function authorityEvidence(name: string, value: unknown) {
  const directory = resolve(process.env.ALOOK_CAUSAL_EVIDENCE_DIR ?? "../../plans/pr854-causal-controls/diagnostics")
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, `pr854_authority-${name}.json`), JSON.stringify(value, null, 2) + "\n")
}

async function seedAuthorityDocument(viewerId: string, withChild = false, withRetiredCategory = false) {
  await clearPersistedCache(viewerId)
  const client = new QueryClient()
  const registry = createCommunityDbRegistry(client, viewerId)
  await registry.preload()
  ingestServers(registry, { servers: [{ id: "target", name: "old server", initial: "O", active: false,
    unread: false, mentions: 0, ownerId: viewerId }] })
  ingestServerDetail(registry, { id: "target", name: "old server", discriminator: "0001", description: "", icon: null,
    ownerId: viewerId, categories: [{ id: "category", name: "old category", channels: [
      { id: "leaf", name: "old leaf", type: "text", active: false, unread: false },
      { id: "forum", name: "old forum", type: "forum", active: false, unread: false },
    ] }] })
  if (withRetiredCategory) {
    registry.collections.categories.utils.writeInsert({ id: "retired-category", serverId: "target", name: "old retired category",
      position: 1, private: true, pending: false })
  }
  if (withChild) registry.collections.channels.utils.writeInsert({ id: "child", serverId: "target", categoryId: null,
    name: "old child", type: "thread", parentChannelId: "forum", parentMessageId: "opener", position: 0,
    archived: false, muted: false, unread: false, tags: [], pending: false })
  ingestMessages(registry, "leaf", [{ id: "cached-message", type: "chat", seq: 7,
    content: "original cached message", createdAt: "2026-09-25T00:00:00.000Z" }])
  if (withChild) ingestMessages(registry, "child", [{ id: "cached-child-message", type: "chat", seq: 1,
    content: "original cached child", createdAt: "2026-09-25T00:00:00.000Z" }])
  await createIdbPersister(viewerId).persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER,
    clientState: dehydrate(client, { shouldDehydrateQuery: (query) => shouldPersistQuery(query.queryKey, query.state.data) }) })
  const disposeRegistry = registry.cleanup
  await disposeRegistry()
  client.clear()
}

function currentAuthorityApi(path: string, viewerId: string) {
  if (path === "/api/community/servers") return { servers: [{ id: "target", name: "fresh server", discriminator: "0001", icon: null, ownerId: viewerId, role: "owner" }] }
  if (path.endsWith("/categories")) return { categories: [{ id: "category", name: "fresh category", position: 0 }] }
  if (path.endsWith("/channels")) return { channels: [
    { id: "leaf", serverId: "target", categoryId: "category", name: "fresh leaf", type: "text", position: 0 },
    { id: "forum", serverId: "target", categoryId: "category", name: "fresh forum", type: "forum", position: 1 },
  ] }
  if (path === "/api/community/channels/child") return { id: "child", serverId: "target", name: "fresh child", type: "thread",
    parentChannelId: "forum", parentMessageId: "opener", creatorId: viewerId, archived: false,
    lastMessageAt: null, createdAt: "2026-09-25T00:00:00.000Z" }
  return undefined
}

describe("actual document authority and quarantined persistence", () => {
  it.each(["held-allow", "error-recover", "secondary-held", "denied", "wrong-target", "wrong-account", "read-delete", "metadata-before-primary", "read-grant"] as const)(
    "uses the actual Provider acquisition boundary: %s", async (scenario) => {
      const viewerId = `authority-${scenario}`
      persistenceIo.actual = true
      persistenceIo.documentAuthority = true
      useCommunityWsStore.getState().reset()
      useCommunityWsStore.getState().activateProfileAccount(viewerId)
      await seedAuthorityDocument(scenario === "wrong-account" ? `${viewerId}-other` : viewerId,
        scenario === "secondary-held" || scenario === "read-delete" || scenario === "metadata-before-primary", scenario === "read-grant")
      persistenceIo.holdRead = scenario === "read-delete" || scenario === "read-grant"
      let allowPrimary = scenario === "secondary-held" || scenario === "wrong-target"
      useMessageStreamStore.getState().resetAll()
      let allowChild = scenario === "metadata-before-primary"
      let denyReleased = false
      const held: Array<() => void> = []
      const calls: Array<{ path: string; at: number; outcome: string }> = []
      apiFetchMock.mockImplementation(async (path: string) => {
        const primary = path.endsWith("/categories") || path.endsWith("/channels")
        if (primary && scenario === "error-recover" && !allowPrimary) {
          calls.push({ path, at: Date.now(), outcome: "unknown-error" })
          throw new Error("controlled offline authority")
        }
        if (primary && scenario === "denied" && !allowPrimary) {
          if (!denyReleased) {
            calls.push({ path, at: Date.now(), outcome: "held-before-denial" })
            await new Promise<void>((resolve) => held.push(resolve))
          }
          calls.push({ path, at: Date.now(), outcome: "denied" })
          throw new ApiError("forbidden", 403)
        }
        if (primary && !allowPrimary || path === "/api/community/channels/child" && !allowChild) {
          calls.push({ path, at: Date.now(), outcome: "held" })
          await new Promise<void>((resolve) => held.push(resolve))
        }
        const data = currentAuthorityApi(path, viewerId)
        if (data) { calls.push({ path, at: Date.now(), outcome: "fresh-metadata" }); return data }
        calls.push({ path, at: Date.now(), outcome: "fresh-content-held" })
        return new Promise(() => {})
      })
      let client!: QueryClient
      let registry!: ReturnType<typeof createCommunityDbRegistry>
      const samples: unknown[] = []
      function Target() {
        client = useQueryClient()
        registry = useOptionalCommunityDbRegistry()!
        const route = useRouteChannelProjection(scenario === "wrong-target" ? "not-cached" : "leaf")
        const { server } = useServer("target")
        const messages = useCanonicalMessagesById()
        const consumer = useMessages(server ? "leaf" : null, { serverId: "target", viewerUserId: viewerId, waitForAnchor: false })
        useLayoutEffect(() => { samples.push({ at: Date.now(), route, server,
          messages: [...(messages?.values() ?? [])], consumer: consumer.messages }) })
        return <><output data-testid="document-authority">{route?.type ?? "unknown"}:{server?.name ?? "pending"}:{[...(messages?.values() ?? [])].map((row) => row.content).join("|")}</output>
          <output data-testid="qualified-message-consumer">{consumer.messages.map((row) => row.content).join("|")}</output></>
      }
      const mounted = render(<QueryProvider userId={viewerId}><Target /></QueryProvider>)
      const record = async (phase: string) => {
        const disk = await get<string>(`alook:qc:v2:${viewerId}:client`)
        authorityEvidence(scenario, { phase, viewerId, calls, samples, disk: disk ? JSON.parse(disk) : null,
          commits: persistenceIo.commits, canonical: Object.fromEntries(Object.entries(registry.collections)
            .map(([name, collection]) => [name, { ready: collection.status, rows: [...collection.values()],
              state: client.getQueryState(communityKeys.communityDbCollection(viewerId, name)) }])) })
      }
      try {
        if (scenario === "read-grant") {
          await waitFor(() => expect(persistenceIo.releaseRead).toBeTypeOf("function"))
          allowPrimary = true
          await act(async () => { await serverProjectedQueryFn(client, "target")() })
          persistenceIo.holdRead = false
          await act(async () => persistenceIo.releaseRead?.())
        }
        if (scenario === "read-delete") {
          await waitFor(() => expect(persistenceIo.releaseRead).toBeTypeOf("function"))
          act(() => dispatchCommunityWsEvents([{ type: "community:channel.delete", serverId: "target", channelId: "forum" }],
            { deliveryMode: "batch", queryClient: client, communityStore: useCommunityStore.getState(),
              wsStore: useCommunityWsStore.getState(), sub: { channelId: "forum" }, viewerUserIdRef: { current: viewerId },
              matchesFocus: () => true, scheduleInboxInvalidate: vi.fn() }))
          persistenceIo.holdRead = false
          await act(async () => persistenceIo.releaseRead?.())
        }
        await waitFor(() => expect(calls.some((call) => call.path.endsWith("/channels"))).toBe(true))
        await act(async () => { await registry.preload() })
        if (scenario === "held-allow" || scenario === "error-recover") {
          await record("unqualified")
          expect.soft(screen.getByTestId("document-authority").textContent).toBe("text:pending:")
          expect.soft(registry.getPendingRouteType("leaf")).toEqual({ id: "leaf", serverId: "target", type: "text", authority: "pending" })
          expect.soft(registry.collections.messages.get("cached-message")).toBeUndefined()
          if (scenario === "error-recover") {
            await waitFor(() => expect(client.getQueryState(communityKeys.server("target"))?.status).toBe("error"))
            const before = persistenceIo.commits.length
            act(() => client.setQueryData(communityKeys.communityDbCollection(viewerId, "readStateClock"), [{ id: "account", revision: 1 }]))
            await waitFor(() => expect(persistenceIo.commits.length).toBeGreaterThan(before), { timeout: 3000 })
            await record("unknown-survives-normal-commit")
            const retained = JSON.parse((await get<string>(`alook:qc:v2:${viewerId}:client`))!)
            expect.soft(retained.clientState.queries.find((query: { queryKey: unknown[] }) => query.queryKey[3] === "messages")
              .state.data.some((row: { id: string }) => row.id === "cached-message")).toBe(true)
          }
          allowPrimary = true
          await act(async () => { for (const release of held.splice(0)) release() })
          if (scenario === "error-recover") await act(async () => { await client.refetchQueries({ queryKey: communityKeys.server("target"), exact: true }) })
          await waitFor(() => expect(screen.getByTestId("document-authority").textContent).toContain("fresh server:original cached message"))
          await waitFor(() => expect(calls.some((call) => call.path.includes("/messages") && call.outcome === "fresh-content-held")).toBe(true))
          await record("allowed-cache-reused")
          expect.soft(screen.getByTestId("qualified-message-consumer").textContent).toBe("original cached message")
          expect.soft(registry.collections.messages.get("cached-message")?.content).toBe("original cached message")
          expect.soft(registry.getPendingRouteType("leaf")).toBeUndefined()
        } else if (scenario === "metadata-before-primary") {
          const proof = captureCommunityLiveSnapshotToken(client)
          await act(async () => {
            const metadata = await fetchChannelMetadata("target", "child")
            publishCommunityChannelMetadata(client, { metadata, proof: { token: proof, signal: undefined } })
          })
          await waitFor(() => expect(registry.collections.messages.get("cached-child-message")?.content).toBe("original cached child"))
          await record("exact-metadata-before-primary")
          expect.soft(registry.collections.messages.get("cached-message")).toBeUndefined()
          expect.soft(registry.collections.servers.get("target")?.name).not.toBe("old server")
          allowPrimary = true
          await act(async () => { for (const release of held.splice(0)) release() })
          await waitFor(() => expect(registry.collections.messages.get("cached-message")?.content).toBe("original cached message"))
          await record("primary-tail-after-exact-scope")
        } else if (scenario === "secondary-held") {
          await waitFor(() => expect(calls.some((call) => call.path === "/api/community/channels/child" && call.outcome === "held")).toBe(true))
          await waitFor(() => expect(screen.getByTestId("document-authority").textContent).toContain("original cached message"))
          await record("primary-before-secondary")
          expect.soft(registry.collections.messages.get("cached-child-message")).toBeUndefined()
          expect.soft(registry.getPendingRouteType("child")?.type).toBe("thread")
          allowChild = true
          await act(async () => { for (const release of held.splice(0)) release() })
          await waitFor(() => expect(registry.collections.messages.get("cached-child-message")?.content).toBe("original cached child"))
          await record("secondary-complete")
        } else if (scenario === "denied") {
          act(() => {
            client.setQueryData(communityKeys.channelMeta("target", "leaf"), { id: "leaf", serverId: "target", type: "text" })
            client.setQueryData(communityKeys.channelMessages("leaf"), { pages: [{ messages: [{ id: "stale-raw-only", content: "must clear" }] }] })
            client.setQueryData(communityKeys.members("target"), { users: [{ id: "stale-member" }] })
          })
          denyReleased = true
          await act(async () => { for (const release of held.splice(0)) release() })
          await waitFor(() => expect(client.getQueryState(communityKeys.server("target"))?.status).toBe("error"), { timeout: 3000 })
          const failures = calls.filter((call) => call.outcome === "denied").length
          const error = client.getQueryState(communityKeys.server("target"))?.error
          for (let turn = 0; turn < 4; turn++) await act(async () => { await Promise.resolve() })
          await waitFor(() => expect(registry.getPendingRouteType("leaf")).toBeUndefined())
          await record("explicit-denial")
          expect.soft(failures).toBeLessThanOrEqual(6)
          expect.soft(calls.filter((call) => call.outcome === "denied")).toHaveLength(failures)
          expect.soft(error).toBeInstanceOf(ApiError)
          expect.soft((error as ApiError).status).toBe(403)
          expect.soft(client.getQueryState(communityKeys.server("target"))?.error).toBe(error)
          expect.soft(client.getQueryState(communityKeys.channelMeta("target", "leaf"))).toBeUndefined()
          expect.soft(client.getQueryState(communityKeys.channelMessages("leaf"))).toBeUndefined()
          expect.soft(client.getQueryState(communityKeys.members("target"))).toBeUndefined()
          expect.soft(registry.collections.messages.get("cached-message")).toBeUndefined()
          expect.soft(registry.collections.channels.get("leaf")).toBeUndefined()
        } else if (scenario === "read-grant") {
          await waitFor(() => expect(registry.collections.messages.get("cached-message")?.content).toBe("original cached message"))
          await record("fresh-primary-before-read-return")
          expect.soft(registry.collections.categories.get("retired-category")).toBeUndefined()
          expect.soft(registry.collections.categories.get("category")?.name).toBe("fresh category")
          expect.soft(registry.collections.channels.get("leaf")?.name).toBe("fresh leaf")
        } else if (scenario === "wrong-account") {
          await record("wrong-account-namespace")
          expect.soft(registry.getPendingRouteType("leaf")).toBeUndefined()
          expect.soft(registry.collections.messages.get("cached-message")).toBeUndefined()
          expect.soft(registry.collections.channels.get("leaf")).toBeUndefined()
        } else if (scenario === "read-delete") {
          const before = persistenceIo.commits.length
          act(() => client.setQueryData(communityKeys.communityDbCollection(viewerId, "readStateClock"), [{ id: "account", revision: 2 }]))
          await waitFor(() => expect(persistenceIo.commits.length).toBeGreaterThan(before), { timeout: 3000 })
          await record("read-overlap-denial-held-authority")
          const disk = JSON.parse((await get<string>(`alook:qc:v2:${viewerId}:client`))!)
          const cachedChannels = disk.clientState.queries.find((query: { queryKey: unknown[] }) => query.queryKey[3] === "channels").state.data
          expect.soft(registry.getPendingRouteType("forum")).toBeUndefined()
          expect.soft(registry.getPendingRouteType("child")).toBeUndefined()
          expect.soft(registry.getPendingRouteType("leaf")?.type).toBe("text")
          expect.soft(cachedChannels.map((row: { id: string }) => row.id)).toEqual(["leaf"])
          expect.soft(registry.collections.messages.get("cached-message")).toBeUndefined()
        } else {
          await waitFor(() => expect(registry.collections.messages.get("cached-message")).toBeDefined())
          await record("wrong-exact-target")
          expect.soft(screen.getByTestId("document-authority").textContent).toContain("unknown:fresh server:")
        }
      } catch (error) {
        await record(`failure:${String(error)}`)
        throw error
      } finally {
        allowPrimary = true; allowChild = true
        for (const release of held.splice(0)) release()
        act(() => mounted.unmount())
        await client.cancelQueries()
        const disposeRegistry = registry.cleanup
        await disposeRegistry()
        client.clear()
        await clearPersistedCache(viewerId)
        if (scenario === "wrong-account") await clearPersistedCache(`${viewerId}-other`)
      }
    })

  it.each(["replacement", "epoch-only"] as const)("rejects obsolete held read without reactivating owner: %s", async (scenario) => {
    let release!: (value: PersistedClient | undefined) => void
    persister.restoreClient.mockImplementationOnce(() => new Promise<PersistedClient | undefined>((resolve) => { release = resolve }))
      .mockResolvedValueOnce(undefined)
    let oldRegistry!: ReturnType<typeof createCommunityDbRegistry>
    let currentRegistry: ReturnType<typeof createCommunityDbRegistry> | undefined
    function Target({ old }: { old: boolean }) {
      const registry = useOptionalCommunityDbRegistry()!
      if (old) oldRegistry = registry; else currentRegistry = registry
      return null
    }
    const oldMount = render(<QueryProvider userId="obsolete-owner"><Target old /></QueryProvider>)
    await waitFor(() => expect(release).toBeTypeOf("function"))
    let currentMount: ReturnType<typeof render> | undefined
    if (scenario === "replacement") {
      act(() => oldMount.unmount())
      currentMount = render(<QueryProvider userId="current-owner"><Target old={false} /></QueryProvider>)
    } else act(() => useCommunityWsStore.getState().activateProfileAccount("current-owner"))
    try {
      await waitFor(() => expect(useCommunityWsStore.getState().profileViewerId).toBe("current-owner"))
      await act(async () => release({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { queries: [], mutations: [] } }))
      authorityEvidence(`obsolete-owner-${scenario}`, { viewer: useCommunityWsStore.getState().profileViewerId,
        oldChannels: [...oldRegistry.collections.channels.values()], currentChannels: currentRegistry ? [...currentRegistry.collections.channels.values()] : null,
        calls: apiFetchMock.mock.calls })
      expect.soft(useCommunityWsStore.getState().profileViewerId).toBe("current-owner")
      expect.soft(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      act(() => { currentMount?.unmount(); oldMount.unmount() })
      const disposeOld = oldRegistry.cleanup; const disposeCurrent = currentRegistry?.cleanup
      await Promise.all([disposeOld(), disposeCurrent?.()])
    }
  })

  it.each([0, Infinity, undefined])("rejects malformed timestamp before canonical publication: %s", async (timestamp) => {
    const viewerId = `malformed-${String(timestamp)}`
    persistenceIo.documentAuthority = true
    persister.restoreClient.mockResolvedValue({ timestamp, buster: PERSIST_BUSTER, clientState: { queries: [], mutations: [] } })
    let registry!: ReturnType<typeof createCommunityDbRegistry>
    function Target() { registry = useOptionalCommunityDbRegistry()!; return null }
    const mounted = render(<QueryProvider userId={viewerId}><Target /></QueryProvider>)
    try {
      await waitFor(() => expect(persister.removeClient).toHaveBeenCalled())
      authorityEvidence(`malformed-${String(timestamp)}`, { timestamp: String(timestamp), removed: persister.removeClient.mock.calls.length,
        channels: [...registry.collections.channels.values()], calls: apiFetchMock.mock.calls })
      expect.soft(apiFetchMock).not.toHaveBeenCalled()
      expect.soft([...registry.collections.channels.values()]).toEqual([])
    } finally { act(() => mounted.unmount()); const disposeRegistry = registry.cleanup; await disposeRegistry() }
  })
})

describe("QueryProvider persistence ordering", () => {
  it("hydrates canonical rows before collection preload can publish an empty snapshot", async () => {
    const viewerId = "restore-order-viewer"
    const message = {
      id: "persisted-message",
      channelId: "persisted-dm",
      type: "chat" as const,
      seq: 1,
      createdAt: "2026-09-25T00:00:00.000Z",
      content: "persisted canonical body",
    }
    const canonicalKey = communityKeys.communityDbCollection(viewerId, "messages")
    const seedClient = new QueryClient()
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "categories"),
      [],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "channels"),
      [{
        id: "persisted-dm",
        serverId: null,
        categoryId: null,
        name: "",
        type: "dm",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        position: 0,
        archived: false,
        muted: false,
        unread: false,
        tags: [],
        pending: false,
        lastMessageAt: null,
      }],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "channelMemberships"),
      [
        {
          id: `persisted-dm:${viewerId}:access`,
          channelId: "persisted-dm",
          userId: viewerId,
          relation: "access",
        },
        {
          id: "persisted-dm:peer:access",
          channelId: "persisted-dm",
          userId: "peer",
          relation: "access",
        },
      ],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(
      communityKeys.communityDbCollection(viewerId, "profiles"),
      [{
        userId: "peer",
        name: "Persisted peer",
        discriminator: "0001",
        avatar: "P",
        avatarVersion: 0,
      }],
      { updatedAt: Date.now() - 60_000 },
    )
    seedClient.setQueryData(canonicalKey, [message], {
      updatedAt: Date.now() - 60_000,
    })
    const persisted: PersistedClient = {
      timestamp: Date.now(),
      buster: PERSIST_BUSTER,
      clientState: dehydrate(seedClient),
    }
    let resolveRestore!: (client: PersistedClient) => void
    persister.restoreClient.mockReturnValue(new Promise((resolve) => {
      resolveRestore = resolve
    }))

    const mounted = { client: null as QueryClient | null }
    function Probe() {
      mounted.client = useQueryClient()
      const trustedRestoredPrimary = useTrustedRestoredPrimary()
      const messages = useCanonicalMessagesById()
      const dms = useDmProjection()
      return React.createElement(
        "output",
        {
          "data-testid": "canonical-message",
          "data-trusted-restored-primary": String(trustedRestoredPrimary),
        },
        [messages?.get(message.id)?.content ?? "missing", dms?.[0]?.name ?? "missing-dm"].join("|"),
      )
    }

    const renderer = render(
      <QueryProvider userId={viewerId}>
        <CurrentUserProvider initialUser={{
          id: viewerId,
          name: "Restored viewer",
          email: "viewer@example.test",
          avatar: "V",
          avatarVersion: 0,
        }}>
          <Probe />
        </CurrentUserProvider>
      </QueryProvider>,
    )

    await waitFor(() => expect(persister.restoreClient).toHaveBeenCalledOnce())
    expect(mounted.client?.getQueryState(canonicalKey)).toMatchObject({
      data: undefined,
      status: "pending",
    })

    await act(async () => resolveRestore(persisted))
    await waitFor(() => {
      expect(screen.getByTestId("canonical-message").textContent)
        .toBe(`${message.content}|Persisted peer`)
    })
    expect(screen.getByTestId("canonical-message"))
      .toHaveAttribute("data-trusted-restored-primary", "true")
    expect(mounted.client?.getQueryData(canonicalKey)).toEqual([message])

    act(() => renderer.unmount())
  })
})


describe("canonical target tree first readable commit", () => {
  it.each(["complete", "empty", "incomplete", "missing", "other-account", "other-target"] as const)(
    "keeps unknown separate from the restored %s target",
    async (kind) => {
      const viewerId = "target-restore-viewer"
      const seed = new QueryClient()
      const seedRegistry = createCommunityDbRegistry(seed, kind === "other-account" ? "former-viewer" : viewerId)
      const { cleanup: disposeSeedRegistry } = seedRegistry
      await seedRegistry.preload()
      if (kind !== "missing") {
        ingestServerDetail(seedRegistry, {
          id: kind === "other-target" ? "foreign-target" : "target", name: "Target", discriminator: "0001", description: "", icon: null, ownerId: viewerId,
          categories: kind === "empty" ? [] : [{ id: "category", name: "Category", channels: [
            { id: "leaf", name: "leaf", type: "text", active: false, unread: false },
          ] }],
        })
      }
      if (kind === "incomplete") {
        seed.setQueryData(communityKeys.communityDbCollection(viewerId, "servers"),
          [{ ...seedRegistry.collections.servers.get("target"), detailComplete: false }])
      }
      const snapshot: PersistedClient = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) }
      await disposeSeedRegistry()
      seed.clear()
      let resolveRestore!: (client: PersistedClient) => void
      persister.restoreClient.mockReturnValue(new Promise<PersistedClient>((resolve) => { resolveRestore = resolve }))
      const commits: Array<{ ready: boolean; cold: boolean; row: boolean; scope: string | undefined }> = []
      let client!: QueryClient
      function Target() {
        client = useQueryClient()
        const { server } = useServer("target")
        const ref = useRef<HTMLDivElement>(null)
        useLayoutEffect(() => {
          commits.push({ ready: server !== null,
            cold: !!ref.current?.querySelector(`[data-testid="${tid.channelSidebarPending("target")}"]`),
            row: !!ref.current?.querySelector(`[data-testid="${tid.channelRow("leaf")}"]`),
            scope: ref.current?.querySelector<HTMLElement>("[data-community-channel-tree-scope]")?.dataset.communityChannelTreeScope })
        })
        return <div ref={ref}><ChannelSidebarScope categories={server?.categories ?? null}
          scopeKey="server:target" targetServerId="target" serverId="target" serverName="Target"
          activeChannel="leaf" setActiveChannel={vi.fn()} isAdmin={false} currentUserId={viewerId} /></div>
      }
      const mounted = render(<QueryProvider userId={viewerId}>
        <CurrentUserProvider initialUser={{ id: viewerId, name: "Viewer", email: "viewer@example.test", avatar: "V", avatarVersion: 0 }}>
          <Target />
        </CurrentUserProvider>
      </QueryProvider>)
      try {
        await waitFor(() => expect(persister.restoreClient).toHaveBeenCalledOnce())
        expect(commits.length).toBeGreaterThan(0)
        expect(commits.every((commit) => !commit.ready && commit.cold && !commit.row && !commit.scope)).toBe(true)
        expect(apiFetchMock).not.toHaveBeenCalled()
        await act(async () => resolveRestore(snapshot))
        const readable = kind === "complete" || kind === "empty"
        await waitFor(() => {
          expect(client.getQueryData(communityKeys.communityDbCollection(viewerId, "channels"))).toBeDefined()
          if (readable) expect(commits.some((commit) => commit.ready)).toBe(true)
          else expect(apiFetchMock).toHaveBeenCalled()
        })
        if (readable) {
          const first = commits.findIndex((commit) => commit.ready)
          expect(commits.slice(first).every((commit) => commit.ready && !commit.cold && commit.scope === "server:target" && commit.row === (kind === "complete"))).toBe(true)
          expect(client.getQueryData(communityKeys.communityDbCollection(viewerId, "servers"))).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "target", detailComplete: true })]))
        } else {
          expect(commits.every((commit) => !commit.ready && commit.cold && !commit.row && !commit.scope)).toBe(true)
        }
      } finally {
        act(() => mounted.unmount())
        await client.cancelQueries()
        client.clear()
      }
    },
  )
})

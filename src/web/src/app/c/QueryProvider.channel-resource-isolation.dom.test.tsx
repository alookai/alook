import React, { useLayoutEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { parseLoadSubsetOptions } from "@tanstack/query-db-collection"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useServer } from "@/hooks/community/use-servers"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { useForumSidebarThreads } from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  useDmProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"
import { channelMetadataResourceKey } from "@/lib/community-db/channel-metadata-resource"
import { dmsResourceKey } from "@/lib/community-db/dms-resource"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import {
  categorySchema,
  channelMembershipSchema,
  channelSchema,
  profileSchema,
} from "@/lib/community-db/schema"

type PersistedRow = {
  metadata?: unknown
  value: Record<string, unknown>
}

type CommitRecord = {
  collectionId: string
  mutations: Array<{ key: string | number; type: string }>
  phase: string
  txId: string
}

type ProjectionRecord = {
  canonicalCategoryIds: string[]
  canonicalChannelIds: string[]
  categoryReadiness: string
  channelReadiness: string
  epoch: number
  owner: "route" | "server"
  phase: string
  projectedChannelIds: string[]
  rawExactIds: string[]
  rawExactStatus: string
  rawServerIds: string[]
  rawServerStatus: string
}

type LossRecord = ProjectionRecord & {
  commits: CommitRecord[]
}

type IsolationCollection = "categories" | "channels" | "channelMemberships" | "profiles"

type ForeignPublicationRecord = {
  commits: CommitRecord[]
  fields: string[]
  phase: string
  publisherShape: IsolationCollection | "unknown"
  rawKey: readonly unknown[]
  rawShape: Record<string, string[]>
  rowIdentity: string | null
  targetCollection: IsolationCollection
}

const boundary = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  currentPhase: "startup",
  currentRegistry: null as CommunityDbRegistry | null,
  firstForeign: null as ForeignPublicationRecord | null,
  firstLoss: null as LossRecord | null,
  getRuntime: vi.fn(),
  monitoring: false,
  persistence: {
    adapter: {
      applyCommittedTx: vi.fn(),
      ensureIndex: vi.fn(),
      loadCollectionMetadata: vi.fn(),
      loadSubset: vi.fn(),
      scanRows: vi.fn(),
    },
  },
  records: [] as ProjectionRecord[],
  commits: [] as CommitRecord[],
  registerClear: vi.fn(() => () => {}),
  rebuildRuntime: vi.fn(() => Promise.resolve()),
  router: { replace: vi.fn() },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => boundary.router,
}))

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => boundary.apiFetch(...args),
  }
})

vi.mock("@/lib/browser-persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/browser-persistence")>()
  return {
    ...actual,
    getBrowserPersistenceRuntime: boundary.getRuntime,
    rebuildBrowserPersistenceRuntime: boundary.rebuildRuntime,
    registerPersistenceClearScope: boundary.registerClear,
  }
})

import { QueryProvider } from "./QueryProvider"

const SERVER_ID = "server-1"
const FORUM_ID = "forum-1"
const CATEGORY_IDS = ["category-1", "category-2", "category-3"]
const CATEGORY_ID = CATEGORY_IDS[0]!
const CHANNEL_IDS = [FORUM_ID, "text-1", "text-2", "text-3"]
const THREAD_ID = "thread-1"
const DM_ID = "dm-1"

const persistedRows = new Map<string, Map<string | number, PersistedRow>>()
const persistedMetadata = new Map<string, Map<string, unknown>>()

function valuesForSubset(
  collectionId: string,
  options: Parameters<PersistedCollectionPersistence["adapter"]["loadSubset"]>[1],
) {
  const filters = parseLoadSubsetOptions(options).filters
  return Array.from(persistedRows.get(collectionId)?.entries() ?? [])
    .filter(([, row]) => filters.every((filter) => {
      if (filter.operator !== "eq") return true
      const field = filter.field.at(-1)
      return typeof field !== "string" || row.value[field] === filter.value
    }))
    .map(([key, row]) => ({ key, ...row }))
}

function rawIds(value: unknown) {
  if (!value || typeof value !== "object" || !("channels" in value)) return []
  const channels = (value as { channels?: Array<{ id?: unknown }> }).channels
  return (channels ?? []).flatMap((channel) => (
    typeof channel.id === "string" ? [channel.id] : []
  )).sort()
}

function plainRow(value: unknown) {
  return value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([field]) => !field.startsWith("$")))
    : value
}

const isolationSchemas = {
  categories: categorySchema,
  channels: channelSchema,
  channelMemberships: channelMembershipSchema,
  profiles: profileSchema,
} as const

function rawShape(value: unknown) {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(Object.entries(value).flatMap(([field, rows]) => (
    Array.isArray(rows)
      ? [[field, rows.map((row) => {
          if (!row || typeof row !== "object") return typeof row
          const record = row as Record<string, unknown>
          return String(record.id ?? record.userId ?? "<no-identity>")
        })]]
      : []
  )))
}

function relevantCommits(phase: string) {
  return boundary.commits
    .filter((commit) => commit.phase === phase && commit.mutations.length > 0)
    .slice(-6)
}

function recordIsolation(registry: CommunityDbRegistry) {
  boundary.currentRegistry = registry
  if (!boundary.monitoring || boundary.firstForeign) return
  for (const targetCollection of Object.keys(isolationSchemas) as IsolationCollection[]) {
    const schema = isolationSchemas[targetCollection]
    for (const value of registry.collections[targetCollection].values()) {
      const row = plainRow(value)
      if (schema.safeParse(row).success) continue
      const publisherShape = (Object.keys(isolationSchemas) as IsolationCollection[])
        .find((candidate) => isolationSchemas[candidate].safeParse(row).success)
        ?? "unknown"
      const record = row && typeof row === "object"
        ? row as Record<string, unknown>
        : {}
      const rawKey = dmsResourceKey("viewer")
      boundary.firstForeign = {
        targetCollection,
        publisherShape,
        phase: boundary.currentPhase,
        fields: Object.keys(record).sort(),
        rowIdentity: typeof record.id === "string"
          ? record.id
          : typeof record.userId === "string"
            ? record.userId
            : null,
        rawKey,
        rawShape: rawShape(registry.queryClient.getQueryData(rawKey)),
        commits: relevantCommits(boundary.currentPhase),
      }
      return
    }
  }
}

function recordProjection(
  owner: ProjectionRecord["owner"],
  epoch: number,
  projectedChannelIds: string[],
  registry: CommunityDbRegistry,
) {
  const queryClient = registry.queryClient
  const record: ProjectionRecord = {
    owner,
    epoch,
    phase: boundary.currentPhase,
    projectedChannelIds: projectedChannelIds.slice().sort(),
    canonicalChannelIds: Array.from(registry.collections.channels.keys()).sort(),
    canonicalCategoryIds: Array.from(registry.collections.categories.keys()).sort(),
    channelReadiness: registry.getCollectionReadiness("channels"),
    categoryReadiness: registry.getCollectionReadiness("categories"),
    rawServerStatus: queryClient.getQueryState(
      serverDetailResourceKey("viewer", SERVER_ID),
    )?.status ?? "absent",
    rawServerIds: rawIds(queryClient.getQueryData(
      serverDetailResourceKey("viewer", SERVER_ID),
    )),
    rawExactStatus: queryClient.getQueryState(
      channelMetadataResourceKey("viewer", SERVER_ID, FORUM_ID),
    )?.status ?? "absent",
    rawExactIds: rawIds(queryClient.getQueryData(
      channelMetadataResourceKey("viewer", SERVER_ID, FORUM_ID),
    )),
  }
  boundary.records.push(record)
  if (
    boundary.monitoring
    && record.rawServerIds.includes(FORUM_ID)
    && (
      !record.canonicalChannelIds.includes(FORUM_ID)
      || !record.canonicalCategoryIds.includes(CATEGORY_ID)
      || !record.projectedChannelIds.includes(FORUM_ID)
    )
    && boundary.firstLoss === null
  ) {
    boundary.firstLoss = {
      ...record,
      commits: relevantCommits(record.phase),
    }
  }
}

function ServerOwnerProbe({ epoch }: { epoch: number }) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useServer(SERVER_ID)
  const projectedChannelIds = result.server?.categories
    .flatMap((category) => category.channels.map((channel) => channel.id)) ?? []
  useLayoutEffect(() => {
    if (registry) recordProjection("server", epoch, projectedChannelIds, registry)
  })
  return <span data-testid="server-owner">{projectedChannelIds.join(",")}</span>
}

function RouteOwnerProbe({ epoch }: { epoch: number }) {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const result = useChannelRouteModel(SERVER_ID, SERVER_ID, FORUM_ID, "viewer")
  const projectedChannelIds = result.server?.categories
    .flatMap((category) => category.channels.map((channel) => channel.id)) ?? []
  useLayoutEffect(() => {
    if (registry && queryClient === registry.queryClient) {
      recordProjection("route", epoch, projectedChannelIds, registry)
    }
  })
  return <span data-testid="route-owner">{projectedChannelIds.join(",")}</span>
}

function DmsOwnerProbe() {
  const registry = useOptionalCommunityDbRegistry()
  const dms = useDmProjection()
  useLayoutEffect(() => {
    if (registry) recordIsolation(registry)
  })
  return <span data-testid="dms-owner">{dms?.map((dm) => dm.id).join(",") ?? "pending"}</span>
}

function SidebarOwnerProbe() {
  const registry = useOptionalCommunityDbRegistry()
  const result = useForumSidebarThreads(SERVER_ID, null)
  useLayoutEffect(() => {
    if (registry) recordIsolation(registry)
  })
  return (
    <span data-testid="sidebar-owner">
      {result.isSuccess ? `success:${result.threads.map((thread) => thread.id).join(",")}` : "pending"}
    </span>
  )
}

function OwnerHarness({ dmsOwner, routeEpoch, serverEpoch, sidebarOwner }: {
  dmsOwner: boolean
  routeEpoch: number
  serverEpoch: number
  sidebarOwner: boolean
}) {
  return (
    <>
      <ServerOwnerProbe epoch={serverEpoch} key={`server-${serverEpoch}`} />
      <RouteOwnerProbe epoch={routeEpoch} key={`route-${routeEpoch}`} />
      {dmsOwner ? <DmsOwnerProbe /> : null}
      {sidebarOwner ? <SidebarOwnerProbe /> : null}
    </>
  )
}

function app(
  routeEpoch: number,
  serverEpoch: number,
  dmsOwner = false,
  sidebarOwner = false,
) {
  return (
    <QueryProvider pending={<span>pending</span>} userId="viewer">
      <OwnerHarness
        dmsOwner={dmsOwner}
        routeEpoch={routeEpoch}
        serverEpoch={serverEpoch}
        sidebarOwner={sidebarOwner}
      />
    </QueryProvider>
  )
}

function latest(owner: ProjectionRecord["owner"], epoch: number) {
  return boundary.records.findLast((record) => (
    record.owner === owner && record.epoch === epoch
  ))
}

function failureTrace() {
  const loss = boundary.firstLoss
  return JSON.stringify({
    firstForeign: boundary.firstForeign,
    loss: loss ? {
      ...loss,
      commits: relevantCommits(loss.phase),
    } : null,
    recentRecords: boundary.records.slice(-12),
  }, null, 2)
}

beforeEach(() => {
  persistedRows.clear()
  persistedMetadata.clear()
  boundary.currentPhase = "startup"
  boundary.currentRegistry = null
  boundary.firstForeign = null
  boundary.firstLoss = null
  boundary.monitoring = false
  boundary.records.length = 0
  boundary.commits.length = 0
  boundary.apiFetch.mockReset()
  boundary.getRuntime.mockReset()
  boundary.rebuildRuntime.mockClear()
  boundary.registerClear.mockClear()
  boundary.router.replace.mockClear()
  for (const method of Object.values(boundary.persistence.adapter)) {
    if ("mockReset" in method) method.mockReset()
  }
  boundary.getRuntime.mockResolvedValue({
    mode: "persistent",
    persistence: boundary.persistence as PersistedCollectionPersistence,
    reason: null,
    close: async () => {},
    inspectCollection: async () => null,
    sizeBytes: async () => null,
  })
  boundary.persistence.adapter.ensureIndex.mockResolvedValue(undefined)
  boundary.persistence.adapter.loadCollectionMetadata.mockImplementation(
    async (collectionId: string) => Array.from(
      persistedMetadata.get(collectionId) ?? [],
      ([key, value]) => ({ key, value }),
    ),
  )
  boundary.persistence.adapter.loadSubset.mockImplementation(
    async (
      collectionId: string,
      options: Parameters<PersistedCollectionPersistence["adapter"]["loadSubset"]>[1],
    ) => valuesForSubset(collectionId, options),
  )
  boundary.persistence.adapter.scanRows.mockImplementation(
    async (collectionId: string) => Array.from(
      persistedRows.get(collectionId)?.entries() ?? [],
      ([key, row]) => ({ key, ...row }),
    ),
  )
  boundary.persistence.adapter.applyCommittedTx.mockImplementation(
    async (
      collectionId: string,
      tx: Parameters<PersistedCollectionPersistence["adapter"]["applyCommittedTx"]>[1],
    ) => {
      boundary.commits.push({
        phase: boundary.currentPhase,
        collectionId,
        txId: tx.txId,
        mutations: tx.mutations.map((mutation) => ({
          type: mutation.type,
          key: mutation.key,
        })),
      })
      const rows = persistedRows.get(collectionId) ?? new Map()
      const metadata = persistedMetadata.get(collectionId) ?? new Map()
      persistedRows.set(collectionId, rows)
      persistedMetadata.set(collectionId, metadata)
      if (tx.truncate) rows.clear()
      for (const mutation of tx.mutations) {
        if (mutation.type === "delete") {
          rows.delete(mutation.key)
        } else {
          const previous = rows.get(mutation.key)
          rows.set(mutation.key, {
            value: mutation.value,
            ...(
              mutation.metadataChanged
                ? { metadata: mutation.metadata }
                : previous?.metadata === undefined
                  ? {}
                  : { metadata: previous.metadata }
            ),
          })
        }
      }
      for (const mutation of tx.rowMetadataMutations ?? []) {
        const row = rows.get(mutation.key)
        if (!row) continue
        if (mutation.type === "set") row.metadata = mutation.value
        else delete row.metadata
      }
      for (const mutation of tx.collectionMetadataMutations ?? []) {
        if (mutation.type === "set") metadata.set(mutation.key, mutation.value)
        else metadata.delete(mutation.key)
      }
    },
  )
  boundary.apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/community/servers") {
      return {
        servers: [{
          id: SERVER_ID,
          name: "Server",
          discriminator: "0001",
          description: "",
          ownerId: "viewer",
          icon: null,
          role: "owner",
        }],
      }
    }
    if (path === `/api/community/servers/${SERVER_ID}/categories`) {
      return {
        categories: CATEGORY_IDS.map((id, position) => ({
          id,
          name: `Category ${position + 1}`,
          private: false,
        })),
      }
    }
    if (path === `/api/community/servers/${SERVER_ID}/channels`) {
      return {
        channels: CHANNEL_IDS.map((id, position) => ({
          id,
          name: id,
          categoryId: CATEGORY_IDS[Math.min(position, CATEGORY_IDS.length - 1)],
          type: id === FORUM_ID ? "forum" : "text",
        })),
      }
    }
    if (path.startsWith(`/api/community/servers/${SERVER_ID}/channels?`)) {
      const activityAt = new Date(Date.now() - 60_000).toISOString()
      const thread = {
        id: THREAD_ID,
        name: "Thread",
        parentChannelId: FORUM_ID,
        parentMessageId: "opener-1",
        activityAt,
        expiresAt: new Date(Date.parse(activityAt) + 72 * 60 * 60 * 1000).toISOString(),
        unread: false,
        serverId: SERVER_ID,
        type: "thread",
        creatorId: "viewer",
        archived: false,
        lastMessageAt: activityAt,
      }
      return {
        channels: [thread],
        canonicalChannels: [thread],
        retainedChannel: null,
        retainedDisposition: null,
        included: {
          parentMessages: [{
            id: "opener-1",
            channelId: FORUM_ID,
            content: "Thread opener",
            seq: 1,
            type: "chat",
          }],
        },
        serverNow: new Date().toISOString(),
      }
    }
    if (path === `/api/community/channels/${FORUM_ID}`) {
      return {
        id: FORUM_ID,
        serverId: SERVER_ID,
        name: FORUM_ID,
        type: "forum",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: "viewer",
        archived: false,
        lastMessageAt: null,
        createdAt: "2026-09-30T00:00:00.000Z",
      }
    }
    if (path === "/api/community/users/me/read-state") {
      return { revision: 0, readStates: [] }
    }
    if (path === "/api/community/users/me/attention") {
      return {
        scopes: [],
        items: [],
        limit: 100,
        truncated: false,
        included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
      }
    }
    if (path === "/api/community/users/me/server-folders") return { folders: [] }
    if (path === "/api/community/users/me/notifications") return []
    if (path === "/api/community/users/me/dms") {
      return {
        conversations: [{
          id: DM_ID,
          userId: "peer-1",
          name: "Peer",
          discriminator: "0002",
          avatar: "P",
          avatarVersion: 0,
          preview: "hello",
          activityAt: new Date().toISOString(),
          lastUnreadSeq: 1,
        }],
      }
    }
    throw new Error(`unexpected API fetch: ${path}`)
  })
})

afterEach(() => {
  useCommunityWsStore.getState().reset()
})

describe("QueryProvider shared channel-resource publication", () => {
  it("keeps DMS, server, metadata, and sidebar publications isolated by collection", async () => {
    const renderer = render(app(0, 0))
    try {
      await waitFor(() => {
        expect(latest("server", 0)?.projectedChannelIds).toEqual(CHANNEL_IDS)
        expect(latest("route", 0)?.projectedChannelIds).toEqual(CHANNEL_IDS)
      })
      await waitFor(() => {
        expect(Array.from(
          persistedRows.get("community-db:viewer:channels")?.keys() ?? [],
        ).sort()).toEqual(CHANNEL_IDS)
        expect(Array.from(
          persistedRows.get("community-db:viewer:categories")?.keys() ?? [],
        ).sort()).toEqual(CATEGORY_IDS)
      })
      boundary.monitoring = true

      boundary.currentPhase = "dms-owners"
      renderer.rerender(app(0, 0, true))
      await waitFor(() => {
        expect(renderer.getByTestId("dms-owner").textContent).toBe(DM_ID)
        expect(boundary.currentRegistry?.queryClient.getQueryState(
          dmsResourceKey("viewer"),
        )?.status).toBe("success")
      })

      boundary.currentPhase = "forum-sidebar-publish"
      renderer.rerender(app(0, 0, true, true))
      await waitFor(() => {
        expect(renderer.getByTestId("sidebar-owner").textContent).toMatch(/^success:/)
        expect(boundary.currentRegistry?.collections.channels.get(THREAD_ID)).toBeDefined()
        expect(boundary.currentRegistry?.collections.channelMemberships.get(
          `${THREAD_ID}:viewer:access`,
        )).toBeDefined()
      })

      expect(boundary.firstForeign, failureTrace()).toBeNull()
      expect(boundary.firstLoss, failureTrace()).toBeNull()
      const registry = boundary.currentRegistry!
      expect(Array.from(registry.collections.categories.values()), failureTrace())
        .toHaveLength(3)
      expect(Array.from(registry.collections.channels.values()).filter((row) => (
        row.serverId === SERVER_ID && row.type !== "thread"
      )), failureTrace()).toHaveLength(4)
      expect(latest("server", 0)?.projectedChannelIds, failureTrace()).toEqual(CHANNEL_IDS)
      expect(latest("route", 0)?.projectedChannelIds, failureTrace()).toEqual(CHANNEL_IDS)
    } finally {
      await act(async () => renderer.unmount())
    }
  })
})

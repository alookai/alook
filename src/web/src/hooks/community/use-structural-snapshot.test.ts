import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail, ServersResponse } from "./use-servers"
import type { FoldersResponse } from "./use-folders"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  installStructuralSnapshotProjection,
  structuralHintServer,
} from "./use-structural-snapshot"

function servers(name = "Alpha"): ServersResponse {
  return {
    servers: [{
      id: "server-1",
      name,
      discriminator: "0001",
      icon: null,
      initial: "A",
      active: false,
      unread: true,
      mentions: 4,
      ownerId: "owner-1",
      isOwner: true,
    }],
  }
}

describe("installStructuralSnapshotProjection", () => {
  let queryClient: QueryClient
  let dispose: () => void

  beforeEach(() => {
    useCommunityWsStore.getState().reset()
    useCommunityWsStore.getState().activateProfileAccount("account-a")
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    dispose = installStructuralSnapshotProjection(queryClient, "account-a")
  })

  afterEach(() => {
    dispose()
    queryClient.clear()
    useCommunityWsStore.getState().reset()
  })

  it("projects authoritative server, folder, tree, and child query success", async () => {
    await queryClient.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => Promise.resolve(servers()),
    })
    const folders: FoldersResponse = {
      folders: [{
        id: "folder-1",
        name: "Work",
        position: 0,
        servers: [{ id: "server-1", name: "Alpha", initial: "A", icon: null }],
      }],
    }
    await queryClient.fetchQuery({
      queryKey: communityKeys.folders(),
      queryFn: () => Promise.resolve(folders),
    })
    const detail = {
      id: "server-1",
      name: "Alpha",
      discriminator: "0001",
      description: "not persisted",
      icon: null,
      ownerId: "owner-1",
      categories: [{
        id: "category-1",
        name: "General",
        private: 1,
        creatorId: "creator-1",
        channels: [{
          id: "channel-1",
          name: "chat",
          type: "text",
          active: false,
          unread: true,
          creatorId: "creator-1",
        }],
      }],
    } satisfies ServerDetail
    await queryClient.fetchQuery({
      queryKey: communityKeys.server("server-1"),
      queryFn: () => Promise.resolve(detail),
    })
    await queryClient.fetchQuery({
      queryKey: communityKeys.channelMeta("server-1", "child-1"),
      queryFn: () => Promise.resolve({
        id: "child-1",
        serverId: "server-1",
        name: "Thread",
        type: "thread",
        parentChannelId: "channel-1",
        parentMessageId: "message-1",
        creatorId: "creator-1",
        archived: false,
        lastMessageAt: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        verifiedEpoch: 0,
      }),
    })

    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toMatchObject({
      accountId: "account-a",
      serverOrder: ["server-1"],
      folders: [{ id: "folder-1", name: "Work", serverIds: ["server-1"] }],
      servers: [{
        id: "server-1",
        categories: [{ id: "category-1", name: "General", private: true }],
        channels: [{ id: "channel-1", name: "chat", type: "text", categoryId: "category-1" }],
        childRouteHints: [{
          id: "child-1",
          name: "Thread",
          type: "thread",
          parentChannelId: "channel-1",
          parentMessageId: "message-1",
        }],
      }],
    })
  })

  it("replays cached folder, tree, and child successes when the server list arrives last", async () => {
    await queryClient.fetchQuery({
      queryKey: communityKeys.folders(),
      queryFn: () => Promise.resolve({
        folders: [{
          id: "folder-1",
          name: "Work",
          position: 0,
          servers: [{ id: "server-1", name: "Alpha", initial: "A", icon: null }],
        }],
      } satisfies FoldersResponse),
    })
    await queryClient.fetchQuery({
      queryKey: communityKeys.server("server-1"),
      queryFn: () => Promise.resolve({
        id: "server-1",
        name: "Alpha",
        discriminator: "0001",
        description: "private live description",
        icon: null,
        ownerId: "owner-1",
        categories: [{
          id: "category-1",
          name: "General",
          private: 0,
          channels: [{
            id: "channel-1",
            name: "chat",
            type: "text",
            active: false,
            unread: false,
          }],
        }],
      } satisfies ServerDetail),
    })
    await queryClient.fetchQuery({
      queryKey: communityKeys.channelMeta("server-1", "child-1"),
      queryFn: () => Promise.resolve({
        id: "child-1",
        serverId: "server-1",
        name: "Thread",
        type: "thread",
        parentChannelId: "channel-1",
        parentMessageId: "message-1",
        creatorId: "creator-1",
        archived: false,
        lastMessageAt: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        verifiedEpoch: 0,
      }),
    })
    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toBeUndefined()

    await queryClient.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => Promise.resolve(servers()),
    })

    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toMatchObject({
      folders: [{ id: "folder-1", serverIds: ["server-1"] }],
      servers: [{
        id: "server-1",
        categories: [{ id: "category-1" }],
        channels: [{ id: "channel-1" }],
        childRouteHints: [{ id: "child-1" }],
      }],
    })
  })

  it("ignores manual optimistic cache writes", async () => {
    await queryClient.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => Promise.resolve(servers()),
    })
    queryClient.setQueryData(communityKeys.servers(), servers("Optimistic"))
    expect(queryClient.getQueryData<{ servers: Array<{ name: string }> }>(
      communityKeys.structuralSnapshot(),
    )?.servers[0]?.name).toBe("Alpha")
  })

  it("rejects projection after the active account changes", async () => {
    useCommunityWsStore.getState().activateProfileAccount("account-b")
    await queryClient.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => Promise.resolve(servers()),
    })
    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toBeUndefined()
  })

  it("removes a malformed restored snapshot", () => {
    dispose()
    queryClient.setQueryData(communityKeys.structuralSnapshot(), {
      schemaVersion: 1,
      accountId: "account-a",
      capturedAt: Date.now(),
      serverOrder: [],
      folders: [],
      servers: [],
      role: "owner",
    })
    dispose = installStructuralSnapshotProjection(queryClient, "account-a")
    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toBeUndefined()
  })

  it("removes structural state for an anonymous account", () => {
    queryClient.setQueryData(communityKeys.structuralSnapshot(), { unsafe: true })
    dispose()
    dispose = installStructuralSnapshotProjection(queryClient, null)

    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toBeUndefined()
  })

  it("rejects malformed data that is already present when a query is added", () => {
    queryClient.getQueryCache().build(
      queryClient,
      { queryKey: communityKeys.structuralSnapshot() },
      { data: { unsafe: true } } as never,
    )

    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toBeUndefined()
  })

  it("projects successful cache entries that predate projection installation", () => {
    dispose()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.servers(), servers("Cached"))

    dispose = installStructuralSnapshotProjection(queryClient, "account-a")

    expect(queryClient.getQueryData(communityKeys.structuralSnapshot())).toMatchObject({
      accountId: "account-a",
      servers: [{ id: "server-1", name: "Cached" }],
    })
  })

  it("removes an archived child receipt from the structural snapshot", async () => {
    await queryClient.fetchQuery({
      queryKey: communityKeys.servers(),
      queryFn: () => Promise.resolve(servers()),
    })
    await queryClient.fetchQuery({
      queryKey: communityKeys.server("server-1"),
      queryFn: () => Promise.resolve({
        id: "server-1",
        name: "Alpha",
        discriminator: "0001",
        description: "",
        icon: null,
        ownerId: "owner-1",
        categories: [{
          id: "category-1",
          name: "General",
          private: 0,
          channels: [{
            id: "channel-1",
            name: "chat",
            type: "text",
            active: false,
            unread: false,
          }],
        }],
      } satisfies ServerDetail),
    })
    queryClient.setQueryData(communityKeys.structuralSnapshot(), (current: any) => ({
      ...current,
      servers: current.servers.map((server: any) => ({
        ...server,
        childRouteHints: [{
          id: "child-1",
          name: "Thread",
          type: "thread",
          parentChannelId: "channel-1",
          parentMessageId: "message-1",
        }],
      })),
    }))
    await queryClient.fetchQuery({
      queryKey: communityKeys.channelMeta("server-1", "child-1"),
      queryFn: () => Promise.resolve({
        id: "child-1",
        serverId: "server-1",
        name: "Thread",
        type: "thread",
        parentChannelId: "channel-1",
        parentMessageId: "message-1",
        archived: true,
      }),
    })

    expect(queryClient.getQueryData<any>(
      communityKeys.structuralSnapshot(),
    ).servers[0].childRouteHints).toEqual([])
  })

  it("projects and misses structural server hints explicitly", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      accountId: "account-a",
      capturedAt: Date.now(),
      serverOrder: ["server-1"],
      folders: [],
      servers: [{
        id: "server-1",
        name: "Alpha",
        discriminator: "0001",
        icon: null,
        categories: [],
        channels: [],
        childRouteHints: [],
      }],
    }

    expect(structuralHintServer(snapshot, "server-1")).toMatchObject({
      id: "server-1",
      categoriesView: [],
    })
    expect(structuralHintServer(snapshot, "missing")).toBeNull()
    expect(structuralHintServer(null, "server-1")).toBeNull()
  })
})

"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query"
import {
  communityKeys,
  isCommunityServerDetailQueryKey,
} from "@/lib/query-keys"
import {
  parseStructuralSnapshot,
  projectServerDetailTree,
  structuralServerToCategories,
  type StructuralSnapshotV1,
  type StructuralServerV1,
  updateStructuralSnapshot,
} from "@/lib/community/structural-snapshot"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { ServersResponse, ServerDetail } from "./use-servers"
import type { FoldersResponse } from "./use-folders"
import type { ChannelMetadata } from "./channel-metadata"

function sameKey(left: QueryKey, right: QueryKey): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function projectLiveStructuralQuery(
  queryClient: QueryClient,
  accountId: string,
  key: QueryKey,
  data: unknown,
): void {
  if (useCommunityWsStore.getState().profileViewerId !== accountId) return
  if (sameKey(key, communityKeys.servers())) {
    const response = data as ServersResponse
    updateStructuralSnapshot(queryClient, {
      type: "replaceServers",
      accountId,
      servers: response.servers.map((server) => ({
        id: server.id,
        name: server.name,
        discriminator: server.discriminator ?? "",
        icon: server.icon ?? null,
      })),
    })
    const folders = queryClient.getQueryData<FoldersResponse>(communityKeys.folders())
    if (folders) {
      projectLiveStructuralQuery(
        queryClient,
        accountId,
        communityKeys.folders(),
        folders,
      )
    }
    for (const server of response.servers) {
      const detail = queryClient.getQueryData<ServerDetail>(communityKeys.server(server.id))
      if (detail) {
        projectLiveStructuralQuery(
          queryClient,
          accountId,
          communityKeys.server(server.id),
          detail,
        )
      }
    }
    return
  }
  if (sameKey(key, communityKeys.folders())) {
    const response = data as FoldersResponse
    updateStructuralSnapshot(queryClient, {
      type: "replaceFolders",
      folders: response.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        serverIds: folder.servers.map((server) => server.id),
      })),
    })
    return
  }
  if (isCommunityServerDetailQueryKey(key)) {
    const serverId = key[2]
    const tree = projectServerDetailTree(data as ServerDetail)
    updateStructuralSnapshot(queryClient, {
      type: "replaceServerTree",
      serverId,
      ...tree,
    })
    for (const [metaKey, meta] of queryClient.getQueriesData<ChannelMetadata & { archived: boolean }>({
      queryKey: communityKeys.channelMetaRoot(serverId),
    })) {
      if (meta) projectLiveStructuralQuery(queryClient, accountId, metaKey, meta)
    }
    return
  }
  if (
    key.length === 5
    && key[0] === "community"
    && key[1] === "servers"
    && key[3] === "channel-meta"
  ) {
    const meta = data as ChannelMetadata & { archived: boolean }
    if (meta.type !== "thread" || !meta.parentChannelId || !meta.parentMessageId) return
    if (meta.archived) {
      updateStructuralSnapshot(queryClient, {
        type: "removeChildHint",
        serverId: meta.serverId,
        channelId: meta.id,
      })
      return
    }
    updateStructuralSnapshot(queryClient, {
      type: "upsertChildHint",
      serverId: meta.serverId,
      child: {
        id: meta.id,
        name: meta.name,
        type: "thread",
        parentChannelId: meta.parentChannelId,
        parentMessageId: meta.parentMessageId,
      },
    })
  }
}

export function installStructuralSnapshotProjection(
  queryClient: QueryClient,
  accountId: string | null,
): () => void {
  if (!accountId) {
    queryClient.removeQueries({ queryKey: communityKeys.structuralSnapshot(), exact: true })
    return () => {}
  }
  const existing = queryClient.getQueryData(communityKeys.structuralSnapshot())
  if (existing !== undefined && !parseStructuralSnapshot(existing, accountId)) {
    queryClient.removeQueries({ queryKey: communityKeys.structuralSnapshot(), exact: true })
  }
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "added" && sameKey(event.query.queryKey, communityKeys.structuralSnapshot())) {
      if (
        event.query.state.data !== undefined
        && !parseStructuralSnapshot(event.query.state.data, accountId)
      ) {
        queryClient.removeQueries({ queryKey: communityKeys.structuralSnapshot(), exact: true })
      }
      return
    }
    if (event.type !== "updated") return
    if (event.action.type !== "success" || event.action.manual) return
    projectLiveStructuralQuery(
      queryClient,
      accountId,
      event.query.queryKey,
      event.query.state.data,
    )
  })
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.state.status === "success") {
      projectLiveStructuralQuery(queryClient, accountId, query.queryKey, query.state.data)
    }
  }
  return unsubscribe
}

export function useStructuralSnapshot(
  accountId: string | null,
  providedQueryClient?: QueryClient,
): StructuralSnapshotV1 | null {
  const queryClient = useQueryClient(providedQueryClient)
  const getSnapshot = useCallback(
    () => queryClient.getQueryData<unknown>(communityKeys.structuralSnapshot()),
    [queryClient],
  )
  const subscribe = useCallback((notify: () => void) => {
    const cache = queryClient.getQueryCache?.()
    if (!cache) return () => {}
    return cache.subscribe((event) => {
      if (sameKey(event.query.queryKey, communityKeys.structuralSnapshot())) notify()
    })
  }, [queryClient])
  const data = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(
    () => accountId ? parseStructuralSnapshot(data, accountId) : null,
    [accountId, data],
  )
}

export function structuralHintServer(
  snapshot: StructuralSnapshotV1 | null,
  serverId: string,
): (StructuralServerV1 & { categoriesView: ReturnType<typeof structuralServerToCategories> }) | null {
  const server = snapshot?.servers.find((candidate) => candidate.id === serverId)
  return server ? { ...server, categoriesView: structuralServerToCategories(server) } : null
}

/** A rail-only Server identity is not enough to initialize a Channel Tree. */
export function hasStructuralServerTree(
  server: Pick<StructuralServerV1, "categories" | "channels"> | null | undefined,
): boolean {
  return Boolean(server && (server.categories.length > 0 || server.channels.length > 0))
}

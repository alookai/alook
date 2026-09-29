"use client"

import { notifyManager, useMutation, useQueryClient } from "@tanstack/react-query"
import type { ServerRailCommand, ServerRailCommitResponse } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import type { RailState } from "@/lib/community/server-rail-model"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  folderItemKey,
  type FolderItemRow,
  type FolderRow,
  type ServerRow,
} from "@/lib/community-db/schema"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import { foldersResourceKey } from "@/lib/community-db/folders-resource"

export type ServerRailCommitArgs = {
  before: RailState
  after: RailState
  commands: ServerRailCommand[]
}

type ServerRailCommitContext = {
  servers: ServerRow[]
  folders: FolderRow[]
  folderItems: FolderItemRow[]
}

function applyOptimisticRail(
  folders: readonly FolderRow[],
  state: RailState,
): { folders: FolderRow[]; folderItems: FolderItemRow[] } {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  return {
    folders: state.folderOrder.map((folderId, position) => ({
      id: folderId,
      name: folderById.get(folderId)?.name ?? "Group",
      position,
    })),
    folderItems: state.folderOrder.flatMap((folderId) => (
      (state.folders[folderId] ?? []).map((serverId, position) => ({
        id: folderItemKey(folderId, serverId),
        folderId,
        serverId,
        position,
      }))
    )),
  }
}

function replaceFolderGraph(
  registry: NonNullable<ReturnType<typeof getCommunityDbRegistry>>,
  folders: FolderRow[],
  folderItems: FolderItemRow[],
) {
  notifyManager.batch(() => {
    registry.collections.folders.utils.writeBatch(() => {
      const nextIds = new Set(folders.map((folder) => folder.id))
      const removed = [...registry.collections.folders.keys()].filter((id) => !nextIds.has(id))
      if (removed.length > 0) registry.collections.folders.utils.writeDelete(removed)
      if (folders.length > 0) registry.collections.folders.utils.writeUpsert(folders)
    })
    registry.collections.folderItems.utils.writeBatch(() => {
      const nextIds = new Set(folderItems.map((item) => item.id))
      const removed = [...registry.collections.folderItems.keys()].filter((id) => !nextIds.has(id))
      if (removed.length > 0) registry.collections.folderItems.utils.writeDelete(removed)
      if (folderItems.length > 0) registry.collections.folderItems.utils.writeUpsert(folderItems)
    })
  })
}

export function useServerRailCommit() {
  const queryClient = useQueryClient()
  const serversKey = serversCollectionQueryKey()
  const scopeId = getCommunityDbRegistry(queryClient)?.scopeId ?? "anon"
  const foldersKey = foldersResourceKey(scopeId)
  return useMutation<
    ServerRailCommitResponse,
    Error,
    ServerRailCommitArgs,
    ServerRailCommitContext
  >({
    scope: { id: "server-rail-commit" },
    mutationFn: ({ commands }) => apiFetch<ServerRailCommitResponse>(
      "/api/community/users/me/server-rail",
      { method: "PATCH", body: JSON.stringify({ commands }) },
    ),
    onMutate: async ({ after }) => {
      const registry = getCommunityDbRegistry(queryClient)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: serversKey, exact: true }),
        queryClient.cancelQueries({ queryKey: foldersKey, exact: true }),
        registry?.ensureCollectionReady("folders"),
        registry?.ensureCollectionReady("folderItems"),
      ])
      const context: ServerRailCommitContext = {
        servers: Array.from(registry?.collections.servers.values() ?? []),
        folders: Array.from(registry?.collections.folders.values() ?? []),
        folderItems: Array.from(registry?.collections.folderItems.values() ?? []),
      }
      const optimistic = applyOptimisticRail(context.folders, after)
      const collection = registry?.collections.servers
      collection?.utils.writeBatch(() => {
        after.serverOrder.forEach((id, position) => {
          if (collection.has(id)) collection.utils.writeUpdate({ id, position })
        })
      })
      if (registry) replaceFolderGraph(registry, optimistic.folders, optimistic.folderItems)
      return context
    },
    onError: (_error, _args, context) => {
      if (!context) return
      const registry = getCommunityDbRegistry(queryClient)
      const collection = registry?.collections.servers
      collection?.utils.writeBatch(() => {
        for (const row of context.servers) {
          if (collection.has(row.id)) collection.utils.writeUpdate(row)
          else collection.utils.writeInsert(row)
        }
      })
      if (registry) replaceFolderGraph(registry, context.folders, context.folderItems)
    },
    onSettled: async () => {
      await Promise.all([
        getCommunityDbRegistry(queryClient)?.requestServerRefetch()
          ?? queryClient.invalidateQueries({ queryKey: serversKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: foldersKey, exact: true }),
      ])
    },
  })
}

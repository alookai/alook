"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ServerRailCommand, ServerRailCommitResponse } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type { FolderServer } from "@/lib/community/models/navigation"
import type { RailState } from "@/lib/community/server-rail-model"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { ServerRow } from "@/lib/community-db/schema"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"

export type ServerRailCommitArgs = {
  before: RailState
  after: RailState
  commands: ServerRailCommand[]
}

type ServerRailCommitContext = {
  servers: ServerRow[]
  folders: FoldersResponse | undefined
}

function applyOptimisticRail(
  servers: readonly ServerRow[],
  folders: FoldersResponse | undefined,
  state: RailState,
): { folders: FoldersResponse | undefined } {
  const serverById = new Map(servers.map((server) => [server.id, server]))
  const folderServerById = new Map<string, FolderServer>()
  for (const folder of folders?.folders ?? []) {
    for (const server of folder.servers) folderServerById.set(server.id, server)
  }
  const asFolderServer = (serverId: string): FolderServer => {
    const existing = folderServerById.get(serverId)
    if (existing) return existing
    const server = serverById.get(serverId)
    return server
      ? { id: server.id, name: server.name, initial: server.name.slice(0, 1).toUpperCase(), icon: server.icon ?? null }
      : { id: serverId, name: "", initial: "?", icon: null }
  }
  const folderById = new Map(folders?.folders.map((folder) => [folder.id, folder]) ?? [])
  return {
    folders: {
      folders: state.folderOrder.map((folderId, position) => ({
        id: folderId,
        name: folderById.get(folderId)?.name ?? "Group",
        position,
        servers: (state.folders[folderId] ?? []).map(asFolderServer),
      })),
    },
  }
}

function reconcileCreatedFolderIds(
  folders: FoldersResponse | undefined,
  createdFolderIds: Record<string, string>,
): FoldersResponse | undefined {
  if (!folders || Object.keys(createdFolderIds).length === 0) return folders
  return {
    ...folders,
    folders: folders.folders.map((folder) => ({
      ...folder,
      id: createdFolderIds[folder.id] ?? folder.id,
    })),
  }
}

export function useServerRailCommit() {
  const queryClient = useQueryClient()
  const serversKey = serversCollectionQueryKey()
  const foldersKey = communityKeys.folders()
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
      await Promise.all([
        queryClient.cancelQueries({ queryKey: serversKey, exact: true }),
        queryClient.cancelQueries({ queryKey: foldersKey, exact: true }),
      ])
      const context: ServerRailCommitContext = {
        servers: Array.from(getCommunityDbRegistry(queryClient)?.collections.servers.values() ?? []),
        folders: queryClient.getQueryData<FoldersResponse>(foldersKey),
      }
      const optimistic = applyOptimisticRail(context.servers, context.folders, after)
      const collection = getCommunityDbRegistry(queryClient)?.collections.servers
      collection?.utils.writeBatch(() => {
        after.serverOrder.forEach((id, position) => {
          if (collection.has(id)) collection.utils.writeUpdate({ id, position })
        })
      })
      queryClient.setQueryData(foldersKey, optimistic.folders)
      return context
    },
    onError: (_error, _args, context) => {
      if (!context) return
      const collection = getCommunityDbRegistry(queryClient)?.collections.servers
      collection?.utils.writeBatch(() => {
        for (const row of context.servers) {
          if (collection.has(row.id)) collection.utils.writeUpdate(row)
          else collection.utils.writeInsert(row)
        }
      })
      queryClient.setQueryData(foldersKey, context.folders)
    },
    onSuccess: (response) => {
      queryClient.setQueryData<FoldersResponse | undefined>(foldersKey, (folders) =>
        reconcileCreatedFolderIds(folders, response.createdFolderIds),
      )
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

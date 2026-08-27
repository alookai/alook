"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ServerRailCommand, ServerRailCommitResponse } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type { ServersResponse } from "@/hooks/community/use-servers"
import type { FolderServer } from "@/lib/community/models/navigation"
import type { RailState } from "@/lib/community/server-rail-model"

export type ServerRailCommitArgs = {
  before: RailState
  after: RailState
  commands: ServerRailCommand[]
}

type ServerRailCommitContext = {
  servers: ServersResponse | undefined
  folders: FoldersResponse | undefined
}

function applyOptimisticRail(
  servers: ServersResponse | undefined,
  folders: FoldersResponse | undefined,
  state: RailState,
): { servers: ServersResponse | undefined; folders: FoldersResponse | undefined } {
  const serverById = new Map(servers?.servers.map((server) => [server.id, server]) ?? [])
  const folderServerById = new Map<string, FolderServer>()
  for (const folder of folders?.folders ?? []) {
    for (const server of folder.servers) folderServerById.set(server.id, server)
  }
  const asFolderServer = (serverId: string): FolderServer => {
    const existing = folderServerById.get(serverId)
    if (existing) return existing
    const server = serverById.get(serverId)
    return server
      ? { id: server.id, name: server.name, initial: server.initial, icon: server.icon ?? null }
      : { id: serverId, name: "", initial: "?", icon: null }
  }
  const folderById = new Map(folders?.folders.map((folder) => [folder.id, folder]) ?? [])
  return {
    servers: servers
      ? {
          ...servers,
          servers: state.serverOrder
            .map((serverId) => serverById.get(serverId))
            .filter((server): server is ServersResponse["servers"][number] => !!server),
        }
      : servers,
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
  const serversKey = communityKeys.servers()
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
        servers: queryClient.getQueryData<ServersResponse>(serversKey),
        folders: queryClient.getQueryData<FoldersResponse>(foldersKey),
      }
      const optimistic = applyOptimisticRail(context.servers, context.folders, after)
      queryClient.setQueryData(serversKey, optimistic.servers)
      queryClient.setQueryData(foldersKey, optimistic.folders)
      return context
    },
    onError: (_error, _args, context) => {
      if (!context) return
      queryClient.setQueryData(serversKey, context.servers)
      queryClient.setQueryData(foldersKey, context.folders)
    },
    onSuccess: (response) => {
      queryClient.setQueryData<FoldersResponse | undefined>(foldersKey, (folders) =>
        reconcileCreatedFolderIds(folders, response.createdFolderIds),
      )
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: serversKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: foldersKey, exact: true }),
      ])
    },
  })
}

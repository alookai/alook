import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { useCommunityWsStore } from "@/stores/community/ws"
import { avatarInitial } from "@/lib/community/avatar"
import type { CommunityFolder } from "@/lib/community/models/navigation"
import { folderItemKey, type FolderItemRow, type FolderRow } from "./schema"

type RawFolder = {
  id: string
  name: string
  position: number
  servers: Array<{ id: string; name: string; icon?: string | null }>
}

export type FoldersResource = {
  folders: CommunityFolder[]
  folderRows: FolderRow[]
  folderItems: FolderItemRow[]
}

export function foldersResourceKey(accountId: string) {
  return ["community", "db", accountId, "folders-resource"] as const
}

function normalizeFoldersResource(data: { folders: RawFolder[] }): FoldersResource {
  const folders = data.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    position: folder.position ?? 0,
    servers: folder.servers.map((server) => ({
      id: server.id,
      name: server.name,
      initial: avatarInitial(server.name),
      icon: server.icon ?? null,
    })),
  }))
  return {
    folders,
    folderRows: folders.map(({ id, name, position }) => ({ id, name, position })),
    folderItems: folders.flatMap((folder) => folder.servers.map((server, position) => ({
      id: folderItemKey(folder.id, server.id),
      folderId: folder.id,
      serverId: server.id,
      position,
    }))),
  }
}

export function createFoldersResourceQueryFn(
  _queryClient: QueryClient,
  _accountId: string,
) {
  return async ({ signal }: QueryFunctionContext): Promise<FoldersResource> => {
    const before = useCommunityWsStore.getState()
    const response = await apiFetch<{ folders: RawFolder[] }>(
      "/api/community/users/me/server-folders",
      { signal },
    )
    const after = useCommunityWsStore.getState()
    if (
      signal?.aborted
      || after.profileViewerId !== before.profileViewerId
      || after.profileAccountEpoch !== before.profileAccountEpoch
      || after.accessEpoch !== before.accessEpoch
    ) throw new DOMException("Stale folders resource", "AbortError")
    return normalizeFoldersResource(response)
  }
}

export function selectFolderRows(resource: FoldersResource) {
  return resource.folderRows
}

export function selectFolderItems(resource: FoldersResource) {
  return resource.folderItems
}

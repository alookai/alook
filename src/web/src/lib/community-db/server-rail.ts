import type { ServerRailProjection, ServerRailState } from "@alook/shared"
import type { CommunityDbRegistry } from "./collections"
import { folderItemKey } from "./schema"

export function readCommunityServerRail(registry: CommunityDbRegistry): ServerRailState {
  const allowed = new Set([...registry.collections.serverMemberships.values()].filter((row) => row.viewer && row.userId === registry.accountId).map((row) => row.serverId))
  const serverOrder = [...registry.collections.servers.values()].filter((row) => allowed.has(row.id)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((row) => row.id)
  const folders = [...registry.collections.folders.values()].sort((a, b) => a.position - b.position)
  const items = [...registry.collections.folderItems.values()].filter((row) => allowed.has(row.serverId)).sort((a, b) => a.position - b.position)
  return {
    serverOrder,
    folderOrder: folders.map((row) => row.id),
    folders: Object.fromEntries(folders.map((row) => [row.id, { id: row.id, name: row.name, serverIds: items.filter((item) => item.folderId === row.id).map((item) => item.serverId) }])),
  }
}

export function mutateCommunityServerRail(registry: CommunityDbRegistry, projection: ServerRailProjection) {
  if (projection.reorderServers) projection.after.serverOrder.forEach((id, position) => registry.collections.servers.update(id, (row) => { row.position = position }))
  for (const id of projection.deletedFolderIds) {
    registry.collections.folders.delete(id)
  }
  for (const folder of projection.createdFolders) registry.collections.folders.insert({ id: folder.id, name: folder.name, position: projection.after.folderOrder.indexOf(folder.id) })
  if (projection.reorderFolders) projection.after.folderOrder.forEach((id, position) => registry.collections.folders.update(id, (row) => { row.position = position }))
  const affected = new Set([...projection.affectedFolderIds, ...projection.createdFolders.map((row) => row.id)])
  const items = [...affected].flatMap((id) => projection.after.folders[id]?.serverIds.map((serverId, position) => ({ id: folderItemKey(id, serverId), folderId: id, serverId, position })) ?? [])
  const desired = new Map(items.map((row) => [row.id, row]))
  const existing = new Set([...registry.collections.folderItems.keys()])
  for (const row of registry.collections.folderItems.values()) if (affected.has(row.folderId) && !desired.has(row.id)) registry.collections.folderItems.delete(row.id)
  for (const row of items) {
    if (existing.has(row.id)) registry.collections.folderItems.update(row.id, (draft) => { draft.position = row.position })
    else registry.collections.folderItems.insert(row)
  }
}

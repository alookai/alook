import { sortServerRailRows, serverRailTopOrder, type ServerRailProjection, type ServerRailState } from "@alook/shared"
import type { CommunityDbRegistry } from "./collections"
import { folderItemKey } from "./schema"

export const serverRailMutationKey = ["community", "server-rail", "change"] as const

export function readCommunityServerRail(registry: CommunityDbRegistry): ServerRailState {
  const allowed = new Set([...registry.collections.serverMemberships.values()].filter((row) => row.viewer && row.userId === registry.accountId).map((row) => row.serverId))
  const serverIds = [...registry.collections.servers.values()].filter((row) => allowed.has(row.id)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((row) => row.id)
  const folders = [...registry.collections.folders.values()]
  const items = [...registry.collections.folderItems.values()].filter((row) => allowed.has(row.serverId)).sort((a, b) => a.position - b.position)
  return {
    ...(registry.collections.serverRail.get("account") ? { topOrder: registry.collections.serverRail.get("account")!.entries } : {}),
    serverIds,
    folderIds: folders.map((row) => row.id),
    folders: Object.fromEntries(folders.map((row) => [row.id, { id: row.id, name: row.name, serverIds: items.filter((item) => item.folderId === row.id).map((item) => item.serverId) }])),
  }
}

export function readCommunityServerRailServers(registry: CommunityDbRegistry) {
  const state = readCommunityServerRail(registry)
  const allowed = new Set(state.serverIds)
  return sortServerRailRows(state, [...registry.collections.servers.values()].filter((row) => allowed.has(row.id)))
}

export function mutateCommunityServerRail(registry: CommunityDbRegistry, projection: ServerRailProjection) {
  if (projection.reorderTopLevel) {
    const entries = serverRailTopOrder(projection.after);
    if (registry.collections.serverRail.has("account")) registry.collections.serverRail.update("account", (row) => { row.entries = entries });
    else registry.collections.serverRail.insert({ id: "account", entries });
  }
  for (const id of projection.deletedFolderIds) {
    registry.collections.folders.delete(id)
  }
  for (const folder of projection.createdFolders) registry.collections.folders.insert({ id: folder.id, name: folder.name })
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

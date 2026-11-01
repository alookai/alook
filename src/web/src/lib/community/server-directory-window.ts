import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION, CommunityChannelResourceSchema, categorySchema, serverSchema, type CommunityCollectionRows } from "@alook/shared"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"

export const ServerDirectorySnapshotSchema = z.strictObject({
  server: serverSchema,
  categories: z.array(categorySchema.omit({ pending: true })),
  channels: z.array(CommunityChannelResourceSchema),
})
export type ServerDirectorySnapshot = z.infer<typeof ServerDirectorySnapshotSchema>

const windowSchema = z.strictObject({
  schemaVersion: z.literal(BUSINESS_SCHEMA_VERSION), accountId: z.string().min(1), serverId: z.string().min(1),
  categoryIds: z.array(z.string().min(1)), channelIds: z.array(z.string().min(1)),
}).refine(window => new Set(window.categoryIds).size === window.categoryIds.length && new Set(window.channelIds).size === window.channelIds.length)
export type ServerDirectoryWindow = z.infer<typeof windowSchema>

export function readServerDirectoryWindow(value: unknown) {
  const parsed = windowSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function isServerDirectoryWindowKey(key: readonly unknown[]) {
  return key.length === 3 && key[0] === "community" && key[1] === "servers" && typeof key[2] === "string"
}

export function serverDirectoryWindowComplete(window: ServerDirectoryWindow, rows: {
  servers: readonly CommunityCollectionRows["servers"][]
  categories: readonly CommunityCollectionRows["categories"][]
  channels: readonly CommunityCollectionRows["channels"][]
}, accountId: string | null, serverId: string) {
  return window.accountId === accountId && window.serverId === serverId && rows.servers.some(row => row.id === serverId)
    && window.categoryIds.every(id => rows.categories.some(row => row.id === id && row.serverId === serverId && !row.pending))
    && window.channelIds.every(id => rows.channels.some(row => row.id === id && row.serverId === serverId && row.parentChannelId === null && !row.pending
      && (row.categoryId === null || window.categoryIds.includes(row.categoryId))))
}

function directoryRows(registry: CommunityDbRegistry) {
  return {
    servers: registry.queryClient.getQueryData<CommunityCollectionRows["servers"][]>(communityKeys.communityDbCollection(registry.scopeId, "servers")) ?? [...registry.collections.servers.values()],
    categories: registry.queryClient.getQueryData<CommunityCollectionRows["categories"][]>(communityKeys.communityDbCollection(registry.scopeId, "categories")) ?? [...registry.collections.categories.values()],
    channels: registry.queryClient.getQueryData<CommunityCollectionRows["channels"][]>(communityKeys.communityDbCollection(registry.scopeId, "channels")) ?? [...registry.collections.channels.values()],
  }
}

export function getServerDirectoryWindow(registry: CommunityDbRegistry | null | undefined, serverId: string) {
  if (!registry) return
  const window = readServerDirectoryWindow(registry.queryClient.getQueryData(communityKeys.server(serverId)))
  return window && serverDirectoryWindowComplete(window, directoryRows(registry), registry.accountId, serverId) ? window : undefined
}

export function recordServerDirectoryWindow(registry: CommunityDbRegistry, serverId: string) {
  if (!registry.accountId) return
  const rows = directoryRows(registry)
  const window = windowSchema.parse({
    schemaVersion: BUSINESS_SCHEMA_VERSION, accountId: registry.accountId, serverId,
    categoryIds: rows.categories.filter(row => row.serverId === serverId && !row.pending).map(row => row.id),
    channelIds: rows.channels.filter(row => row.serverId === serverId && row.parentChannelId === null && !row.pending).map(row => row.id),
  })
  registry.queryClient.setQueryData(communityKeys.server(serverId), window)
  return window
}

export function reconcileExistingServerDirectoryWindows(registry: CommunityDbRegistry) {
  for (const query of registry.queryClient.getQueryCache().findAll({ queryKey: communityKeys.servers() })) {
    if (!isServerDirectoryWindowKey(query.queryKey)) continue
    const window = readServerDirectoryWindow(query.state.data)
    if (window?.accountId === registry.accountId) recordServerDirectoryWindow(registry, window.serverId)
  }
}

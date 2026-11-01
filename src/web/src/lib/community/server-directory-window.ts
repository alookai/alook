import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION, CommunityChannelResourceSchema, categorySchema, serverSchema, type CommunityCollectionRows } from "@alook/shared"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import { readCommunityCollectionRow } from "@/lib/community-db/write"

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
  const categories = new Map(rows.categories.map(row => [row.id, row]))
  const channels = new Map(rows.channels.map(row => [row.id, row]))
  const categoryIds = new Set(window.categoryIds)
  return window.accountId === accountId && window.serverId === serverId && rows.servers.some(row => row.id === serverId)
    && window.categoryIds.every(id => { const row = categories.get(id); return row?.serverId === serverId && !row.pending })
    && window.channelIds.every(id => { const row = channels.get(id); return row?.serverId === serverId && row.parentChannelId === null && !row.pending
      && (row.categoryId === null || categoryIds.has(row.categoryId)) })
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
  if (!window) return
  const server = readCommunityCollectionRow(registry, "servers", serverId)
  const rows = {
    servers: server ? [server] : [],
    categories: window.categoryIds.flatMap(id => { const row = readCommunityCollectionRow(registry, "categories", id); return row ? [row] : [] }),
    channels: window.channelIds.flatMap(id => { const row = readCommunityCollectionRow(registry, "channels", id); return row ? [row] : [] }),
  }
  return serverDirectoryWindowComplete(window, rows, registry.accountId, serverId) ? window : undefined
}

export function recordServerDirectoryWindow(registry: CommunityDbRegistry, serverId: string) {
  if (!registry.accountId) return
  const rows = directoryRows(registry)
  const window = windowSchema.parse({
    schemaVersion: BUSINESS_SCHEMA_VERSION, accountId: registry.accountId, serverId,
    categoryIds: rows.categories.filter(row => row.serverId === serverId && !row.pending).map(row => row.id),
    channelIds: rows.channels.filter(row => row.serverId === serverId && row.parentChannelId === null && !row.pending).map(row => row.id),
  })
  const current = registry.queryClient.getQueryData<ServerDirectoryWindow>(communityKeys.server(serverId))
  const previous = readServerDirectoryWindow(current)
  if (previous?.accountId === window.accountId && previous.serverId === serverId
    && previous.categoryIds.length === window.categoryIds.length && previous.channelIds.length === window.channelIds.length) {
    const categories = new Set(previous.categoryIds), channels = new Set(previous.channelIds)
    if (window.categoryIds.every(id => categories.has(id)) && window.channelIds.every(id => channels.has(id))) return current
  }
  registry.queryClient.setQueryData(communityKeys.server(serverId), window)
  return window
}

export function reconcileExistingServerDirectoryWindows(registry: CommunityDbRegistry, serverIds: ReadonlySet<string>) {
  for (const serverId of serverIds) {
    const window = readServerDirectoryWindow(registry.queryClient.getQueryData(communityKeys.server(serverId)))
    if (window?.accountId === registry.accountId && window.serverId === serverId) recordServerDirectoryWindow(registry, serverId)
  }
}

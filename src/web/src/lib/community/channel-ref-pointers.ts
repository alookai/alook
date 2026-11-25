import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION, parseNameAndTag, type CommunityCollectionRows } from "@alook/shared"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import { readCommunityCollectionRow } from "@/lib/community-db/write"
import { parseChannelRefDestination, type ChannelRefTarget } from "./channel-ref"

const MAX_PERSISTED_CHANNEL_REF_POINTERS = 500

const pointerEntrySchema = z.strictObject({
  serverId: z.string().min(1),
  channelId: z.string().min(1),
})

const pointersWindowSchema = z.strictObject({
  schemaVersion: z.literal(BUSINESS_SCHEMA_VERSION),
  accountId: z.string().min(1),
  pointers: z.record(z.string().min(1), pointerEntrySchema),
})

export type ChannelRefPointerEntry = z.infer<typeof pointerEntrySchema>
export type ChannelRefPointersWindow = z.infer<typeof pointersWindowSchema>

export function isChannelRefPointersKey(key: readonly unknown[]) {
  return key.length === 2 && key[0] === "community" && key[1] === "channel-ref-pointers"
}

export function readChannelRefPointers(value: unknown): ChannelRefPointersWindow | undefined {
  const parsed = pointersWindowSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function asciiNoCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

function readCollectionRows<N extends "servers" | "channels">(
  registry: CommunityDbRegistry,
  name: N,
): CommunityCollectionRows[N][] {
  const queryRows = registry.queryClient.getQueryData<CommunityCollectionRows[N][]>(
    communityKeys.communityDbCollection(registry.scopeId, name),
  )
  if (Array.isArray(queryRows)) return queryRows
  return [...registry.collections[name].values()] as CommunityCollectionRows[N][]
}

export function scrubChannelRefPointers(
  window: ChannelRefPointersWindow,
  rows: {
    servers: readonly CommunityCollectionRows["servers"][]
    channels: readonly CommunityCollectionRows["channels"][]
  },
  userId: string | null,
  retiredIds: ReadonlySet<string> = new Set(),
): ChannelRefPointersWindow | undefined {
  if (!userId || window.accountId !== userId) return undefined
  const serverIds = new Set(rows.servers.map((row) => row.id))
  const channelById = new Map(rows.channels.map((row) => [row.id, row]))
  const kept: Array<[string, ChannelRefPointerEntry]> = []
  for (const [ref, entry] of Object.entries(window.pointers)) {
    const destination = parseChannelRefDestination(ref)
    if (!destination || destination.ref !== ref || destination.threadRootSeq === undefined) continue
    if (!serverIds.has(entry.serverId) || retiredIds.has(entry.channelId)) continue
    const channel = channelById.get(entry.channelId)
    if (!channel || channel.serverId !== entry.serverId || channel.pending) continue
    if (channel.parentChannelId && retiredIds.has(channel.parentChannelId)) continue
    kept.push([ref, entry])
  }
  if (kept.length === 0) return undefined
  const bounded = kept.length > MAX_PERSISTED_CHANNEL_REF_POINTERS
    ? kept.slice(-MAX_PERSISTED_CHANNEL_REF_POINTERS)
    : kept
  return {
    schemaVersion: BUSINESS_SCHEMA_VERSION,
    accountId: userId,
    pointers: Object.fromEntries(bounded),
  }
}

export function upsertChannelRefPointers(
  registry: CommunityDbRegistry,
  updates: readonly { ref: string; serverId: string; channelId: string }[],
  removals: readonly string[] = [],
) {
  if (!registry.accountId || !registry.runtime.lifecycle.get().active) return
  const key = communityKeys.channelRefPointers()
  const existing = readChannelRefPointers(registry.queryClient.getQueryData(key))
  const basePointers = existing?.accountId === registry.accountId ? existing.pointers : {}
  const next = new Map<string, ChannelRefPointerEntry>(Object.entries(basePointers))
  let changed = !existing || existing.accountId !== registry.accountId

  for (const rawRef of removals) {
    const normalized = parseChannelRefDestination(rawRef)?.ref ?? rawRef
    if (next.delete(normalized)) changed = true
  }

  for (const update of updates) {
    const destination = parseChannelRefDestination(update.ref)
    if (!destination || destination.threadRootSeq === undefined) continue
    const previous = next.get(destination.ref)
    if (previous?.serverId === update.serverId && previous.channelId === update.channelId) continue
    next.delete(destination.ref)
    next.set(destination.ref, { serverId: update.serverId, channelId: update.channelId })
    changed = true
  }

  if (!changed) return
  if (next.size === 0) {
    if (existing !== undefined) registry.queryClient.removeQueries({ queryKey: key, exact: true })
    return
  }
  const entries = [...next.entries()]
  const bounded = entries.length > MAX_PERSISTED_CHANNEL_REF_POINTERS
    ? entries.slice(-MAX_PERSISTED_CHANNEL_REF_POINTERS)
    : entries
  registry.queryClient.setQueryData<ChannelRefPointersWindow>(key, {
    schemaVersion: BUSINESS_SCHEMA_VERSION,
    accountId: registry.accountId,
    pointers: Object.fromEntries(bounded),
  })
}

export function pruneChannelRefPointers(
  registry: CommunityDbRegistry,
  scope: {
    serverId?: string
    channelIds?: ReadonlySet<string>
    refs?: ReadonlySet<string>
  },
) {
  if (!registry.accountId) return
  const key = communityKeys.channelRefPointers()
  const existing = readChannelRefPointers(registry.queryClient.getQueryData(key))
  if (!existing || existing.accountId !== registry.accountId) return
  const next: Record<string, ChannelRefPointerEntry> = {}
  let changed = false
  for (const [ref, entry] of Object.entries(existing.pointers)) {
    const channel = readCommunityCollectionRow(registry, "channels", entry.channelId)
    const drop = Boolean(
      (scope.serverId && entry.serverId === scope.serverId)
      || (scope.channelIds && (
        scope.channelIds.has(entry.channelId)
        || (channel?.parentChannelId && scope.channelIds.has(channel.parentChannelId))
      ))
      || (scope.refs && scope.refs.has(ref)),
    )
    if (drop) {
      changed = true
      continue
    }
    next[ref] = entry
  }
  if (!changed) return
  if (Object.keys(next).length === 0) {
    registry.queryClient.removeQueries({ queryKey: key, exact: true })
    return
  }
  registry.queryClient.setQueryData<ChannelRefPointersWindow>(key, {
    schemaVersion: BUSINESS_SCHEMA_VERSION,
    accountId: registry.accountId,
    pointers: next,
  })
}

export function pruneChannelRefPointersAgainstDb(
  registry: CommunityDbRegistry,
  options?: {
    blockedServers?: ReadonlySet<string>
    isRetiredChannel?: (id: string) => boolean
  },
) {
  if (!registry.accountId) return
  const key = communityKeys.channelRefPointers()
  const existing = readChannelRefPointers(registry.queryClient.getQueryData(key))
  if (!existing) return
  if (existing.accountId !== registry.accountId) {
    registry.queryClient.removeQueries({ queryKey: key, exact: true })
    return
  }
  const next: Record<string, ChannelRefPointerEntry> = {}
  let changed = false
  const ws = registry.runtime.ws.get()
  for (const [ref, entry] of Object.entries(existing.pointers)) {
    const server = readCommunityCollectionRow(registry, "servers", entry.serverId)
    const channel = readCommunityCollectionRow(registry, "channels", entry.channelId)
    const invalid = !server || !channel || channel.serverId !== server.id || channel.pending
      || options?.blockedServers?.has(server.id)
      || ws.revokedServerIds.has(server.id)
      || options?.isRetiredChannel?.(channel.id)
      || (channel.parentChannelId !== null && options?.isRetiredChannel?.(channel.parentChannelId))
      || registry.runtime.ws.actions.isChannelAccessRevoked(channel.id, server.id, channel.parentChannelId ?? undefined)
    if (invalid) {
      changed = true
      continue
    }
    next[ref] = entry
  }
  if (!changed) return
  if (Object.keys(next).length === 0) {
    registry.queryClient.removeQueries({ queryKey: key, exact: true })
    return
  }
  registry.queryClient.setQueryData<ChannelRefPointersWindow>(key, {
    schemaVersion: BUSINESS_SCHEMA_VERSION,
    accountId: registry.accountId,
    pointers: next,
  })
}

export type CommunityDbChannelRefLookup =
  | { status: "ready"; target: ChannelRefTarget }
  | { status: "revoked" }
  | { status: "miss" }

export function resolveChannelRefFromCommunityDb(
  registry: CommunityDbRegistry | null | undefined,
  destination: NonNullable<ReturnType<typeof parseChannelRefDestination>>,
): CommunityDbChannelRefLookup {
  if (!registry || !registry.accountId || !registry.runtime.lifecycle.get().active) return { status: "miss" }
  if (destination.threadRootSeq === undefined) {
    const handle = parseNameAndTag(destination.server)
    if (!handle) return { status: "miss" }
    const server = readCollectionRows(registry, "servers").find((row) =>
      asciiNoCase(row.name) === asciiNoCase(handle.name) && row.discriminator === handle.discriminator,
    )
    if (!server) return { status: "miss" }
    if (registry.runtime.ws.get().revokedServerIds.has(server.id)) return { status: "revoked" }
    const channel = readCollectionRows(registry, "channels").find((row) =>
      row.serverId === server.id
      && row.parentChannelId === null
      && !row.pending
      && (row.type === "text" || row.type === "forum")
      && row.name === destination.channel,
    )
    if (!channel) return { status: "miss" }
    if (registry.runtime.ws.actions.isChannelAccessRevoked(channel.id, server.id)) return { status: "revoked" }
    return {
      status: "ready",
      target: {
        server: { id: server.id, name: server.name },
        channel: { id: channel.id, name: channel.name ?? "", parentChannelId: null },
      },
    }
  }

  const window = readChannelRefPointers(registry.queryClient.getQueryData(communityKeys.channelRefPointers()))
  if (!window || window.accountId !== registry.accountId) return { status: "miss" }
  const pointer = window.pointers[destination.ref]
  if (!pointer) return { status: "miss" }
  const server = readCommunityCollectionRow(registry, "servers", pointer.serverId)
  const channel = readCommunityCollectionRow(registry, "channels", pointer.channelId)
  if (registry.runtime.ws.actions.isChannelAccessRevoked(pointer.channelId, pointer.serverId, channel?.parentChannelId ?? undefined)) {
    return { status: "revoked" }
  }
  if (!server || !channel || channel.serverId !== server.id || channel.pending) return { status: "miss" }
  return {
    status: "ready",
    target: {
      server: { id: server.id, name: server.name },
      channel: { id: channel.id, name: channel.name ?? "", parentChannelId: channel.parentChannelId },
    },
  }
}

export function readLiveChannelRefTarget(
  registry: CommunityDbRegistry | null | undefined,
  target: ChannelRefTarget,
): ChannelRefTarget {
  if (!registry || !registry.runtime.lifecycle.get().active) return target
  const server = readCommunityCollectionRow(registry, "servers", target.server.id)
  const channel = readCommunityCollectionRow(registry, "channels", target.channel.id)
  const serverName = server?.name ?? target.server.name
  const channelName = channel?.name ?? target.channel.name
  const parentChannelId = channel ? channel.parentChannelId : target.channel.parentChannelId
  if (
    serverName === target.server.name
    && channelName === target.channel.name
    && parentChannelId === target.channel.parentChannelId
  ) {
    return target
  }
  return {
    server: { id: target.server.id, name: serverName },
    channel: { id: target.channel.id, name: channelName, parentChannelId },
  }
}

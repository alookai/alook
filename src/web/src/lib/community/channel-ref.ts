import { DM_SERVER, formatRef, parseNameAndTag, parseRef } from "@alook/shared"
import type { CommunityWsStoreState } from "@/stores/community/ws-store"

export type ChannelRefTarget = {
  server: { id: string; name: string }
  channel: { id: string; name: string; parentChannelId: string | null }
}

const referenceScopes = new WeakMap<CommunityWsStoreState["channelAccessScopes"], string>()
const referenceServers = new WeakMap<CommunityWsStoreState["revokedServerIds"], string>()
export type ChannelRefAccessState = Pick<CommunityWsStoreState, "profileAccountEpoch" | "accessEpoch" | "serverAccessGenerations" | "revokedServerIds" | "channelAccessScopes">

export function channelRefAccessQualification(state: ChannelRefAccessState, target?: ChannelRefTarget) {
  if (target) {
    const scope = (id: string, parentId: string | null) => {
      const value = state.channelAccessScopes.get(id)
      return [id, value?.generation ?? 0, value?.revoked ?? false, value?.serverId ?? target.server.id, value?.parentChannelId ?? parentId]
    }
    return JSON.stringify([state.profileAccountEpoch, state.serverAccessGenerations.get(target.server.id) ?? 0,
      state.revokedServerIds.has(target.server.id), scope(target.channel.id, target.channel.parentChannelId),
      target.channel.parentChannelId ? scope(target.channel.parentChannelId, null) : null])
  }
  let scopes = referenceScopes.get(state.channelAccessScopes)
  if (scopes === undefined) {
    scopes = JSON.stringify([...state.channelAccessScopes].filter(([, scope]) => scope.generation > 0 || scope.revoked)
      .sort(([left], [right]) => left.localeCompare(right)).map(([id, scope]) => [id, scope.generation, scope.revoked]))
    referenceScopes.set(state.channelAccessScopes, scopes)
  }
  let servers = referenceServers.get(state.revokedServerIds)
  if (servers === undefined) {
    servers = JSON.stringify([...state.revokedServerIds].sort())
    referenceServers.set(state.revokedServerIds, servers)
  }
  return JSON.stringify([state.profileAccountEpoch, state.accessEpoch, scopes, servers])
}

export function channelRefTargetAffected(target: ChannelRefTarget | undefined, scope?: { serverId?: string | null; channelId?: string }) {
  return !scope || !target || (scope.channelId
    ? target.channel.id === scope.channelId || target.channel.parentChannelId === scope.channelId
    : target.server.id === scope.serverId)
}

export function parseChannelRefDestination(ref: string) {
  try {
    const parsed = parseRef(ref)
    const handle = parseNameAndTag(parsed.server)
    if (parsed.server === DM_SERVER || !handle) return null
    const server = `${asciiNoCase(handle.name)}#${handle.discriminator}`
    return {
      ref: formatRef({ ...parsed, server, seq: undefined }),
      server,
      serverName: handle.name,
      channel: parsed.channel,
      threadRootSeq: parsed.threadRootSeq,
      messageSeq: parsed.seq,
    }
  } catch {
    return null
  }
}

/**
 * Client-side "directory" of every channel-ref-resolvable server + channel —
 * built from already-fetched data (see `use-channel-ref-directory.ts`), not
 * a fresh fetch per ref. Scoped to whatever servers/channels the client
 * already has loaded.
 *
 * This file is used by `/c` UI only. Real-server segments still obey the
 * public ref contract and require a name#discriminator handle.
 */
type ChannelRefDirectoryChannel = {
  id: string
  name: string
  type?: "text" | "forum"
}
export type ChannelRefDirectoryServer = {
  id: string
  name: string
  discriminator: string
  channels: ChannelRefDirectoryChannel[]
}
export type ChannelRefDirectory = ChannelRefDirectoryServer[]

export type ResolvedChannelRef = {
  server: ChannelRefDirectoryServer
  channel: ChannelRefDirectoryChannel
  threadRootSeq?: number
  seq?: number
}

/**
 * Resolve a raw `/server/channel` (or `/server/channel/#N`) ref string
 * against an already-fetched client-side directory. Server identity is an
 * exact name#discriminator handle, case-insensitive on name, matching the
 * database unique index. Channel ids remain accepted inside that resolved
 * server for UI-internal navigation.
 *
 * Returns `null` on any miss (unknown server, unknown channel, or malformed
 * ref), preventing the caller from inventing a clickable target. Syntactically
 * matched refs still render as muted pills while unresolved.
 */
export function resolveChannelRefBase(
  directory: ChannelRefDirectory,
  ref: string,
): ResolvedChannelRef | null {
  let parsed: ReturnType<typeof parseRef>
  try {
    parsed = parseRef(ref)
  } catch {
    return null
  }

  const server = resolveDirectoryServer(directory, parsed.server)
  if (!server) return null

  const channel =
    server.channels.find((c) => c.id === parsed.channel) ??
    server.channels.find((c) => c.name === parsed.channel)
  if (!channel) return null

  return {
    server,
    channel,
    ...(parsed.threadRootSeq !== undefined ? { threadRootSeq: parsed.threadRootSeq } : {}),
    ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
  }
}

/**
 * Resolve a bare `/server` ref (one segment, no channel — `parseRef` throws
 * on this shape since it requires `/<server>/<channel>`) against the
 * already-fetched directory. Only a name#discriminator handle resolves.
 */
export function resolveServerRefBase(
  directory: ChannelRefDirectory,
  ref: string,
): ChannelRefDirectoryServer | null {
  if (!ref.startsWith("/")) return null
  const body = ref.slice(1)
  if (!body || body.includes("/")) return null

  return resolveDirectoryServer(directory, body)
}

function resolveDirectoryServer(
  directory: ChannelRefDirectory,
  segment: string,
): ChannelRefDirectoryServer | null {
  const handle = parseNameAndTag(segment)
  if (!handle) return null
  return directory.find((server) =>
    asciiNoCase(server.name) === asciiNoCase(handle.name)
    && server.discriminator === handle.discriminator
  ) ?? null
}

function asciiNoCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

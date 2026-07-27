/**
 * Client-side "directory" of every channel-ref-resolvable server + channel —
 * built from already-fetched data (see `use-channel-ref-directory.ts`), not
 * a fresh fetch per ref. Scoped to whatever servers/channels the client
 * already has loaded.
 *
 * This file is used by `/c` UI only and MAY accept raw ids (message-ref
 * pill rendering, in-window navigation both round-trip channel ids). The
 * agent-facing resolver (`resolveChannelByNameForMember`) does NOT accept
 * ids — do not use this helper on agent code paths.
 */
type ChannelRefDirectoryChannel = { id: string; name: string }
type ChannelRefDirectoryServer = {
  id: string
  name: string
  channels: ChannelRefDirectoryChannel[]
}
export type ChannelRefDirectory = ChannelRefDirectoryServer[]

export type ResolvedChannelRef = {
  server: ChannelRefDirectoryServer
  channel: ChannelRefDirectoryChannel
}

const CHANNEL_REF_TOKEN_RE = /^<#([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)>$/

/**
 * Resolve a `<#serverId:channelId>` token against an already-fetched
 * client-side directory. Both segments are ids, so lookup is by id only — no
 * name fallback, no ambiguity. Purely in-memory (no network call).
 *
 * Returns `null` on any miss (unknown server, unknown channel, or a token
 * that doesn't match the grammar) — this is the false-positive guard the
 * caller (`describeChannelRefPillView`) relies on to fall back to plain text
 * instead of rendering a broken pill.
 */
export function resolveChannelRefBase(
  directory: ChannelRefDirectory,
  ref: string,
): ResolvedChannelRef | null {
  const match = CHANNEL_REF_TOKEN_RE.exec(ref)
  if (!match) return null
  const [, serverId, channelId] = match

  const server = directory.find((s) => s.id === serverId)
  if (!server) return null

  const channel = server.channels.find((c) => c.id === channelId)
  if (!channel) return null

  return { server, channel }
}

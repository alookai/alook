import { parseNameAndTag, parseRef } from "@alook/shared"

/**
 * Client-side "directory" of every channel-ref-resolvable server + channel —
 * built from already-fetched data (see `use-channel-ref-directory.ts`), not
 * a fresh fetch per ref. Scoped to whatever servers/channels the client
 * already has loaded.
 *
 * This file is used by `/c` UI only. Real-server segments still obey the
 * public ref contract and require a name#discriminator handle.
 */
type ChannelRefDirectoryChannel = { id: string; name: string }
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

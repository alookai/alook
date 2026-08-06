import { parseNameAndTag, parseRef } from "@alook/shared"

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
 * against an already-fetched client-side directory. UI-only: tries id
 * first, then unique handle or unambiguous name — the id fallback exists here because pill links
 * and in-window navigation store raw channel ids. Purely in-memory (no
 * network call) and no ambiguity error. The agent-facing resolver accepts
 * ids, handles, and names through its member-scoped database path; this
 * in-memory helper must not be used on agent code paths.
 *
 * Server names aren't unique, so a duplicate bare name is unresolved rather
 * than silently selecting the first server. A `name#discriminator` handle is
 * exact and case-insensitive on name, matching the database unique index.
 *
 * Returns `null` on any miss (unknown server, unknown channel, or malformed
 * ref) — this is the false-positive guard the caller (`describeChannelRefPillView`)
 * relies on to fall back to plain text instead of rendering a broken pill.
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
 * already-fetched directory. UI-only: id, unique handle, then unambiguous
 * case-insensitive name. Not for agent code paths.
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
  const byId = directory.find((server) => server.id === segment)
  if (byId) return byId

  const handle = parseNameAndTag(segment)
  if (handle) {
    return directory.find((server) =>
      asciiNoCase(server.name) === asciiNoCase(handle.name)
      && server.discriminator === handle.discriminator
    ) ?? null
  }

  const foldedSegment = asciiNoCase(segment)
  const byName = directory.filter((server) => asciiNoCase(server.name) === foldedSegment)
  return byName.length === 1 ? byName[0]! : null
}

function asciiNoCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

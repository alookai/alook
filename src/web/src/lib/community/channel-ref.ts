import { parseRef } from "@alook/shared"

/**
 * Client-side "directory" of every channel-ref-resolvable server + channel —
 * built from already-fetched data (see `use-channel-ref-directory.ts`), not
 * a fresh fetch per ref. Mirrors the shape the backend resolves against
 * (`resolveServerByNameForMember`/`resolveChannelByNameForMember`), scoped to
 * whatever servers/channels the client already has loaded.
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
  threadRootSeq?: number
}

/**
 * Resolve a raw `/server/channel` (or `/server/channel/#N`) ref string
 * against an already-fetched client-side directory. Mirrors
 * `resolveServerByNameForMember`/`resolveChannelByNameForMember`'s
 * id-then-exact-name lookup precedence, but purely in-memory — no network
 * call, and no ambiguity error.
 *
 * Ambiguity tie-break (deliberately simpler than the backend): server/channel
 * names aren't unique in the schema, and the backend surfaces 2+ name matches
 * as a `hint`-carrying 400 the caller must resolve. This function does NOT
 * replicate that — it takes the FIRST match in `directory`/`channels` array
 * order (plain `Array.prototype.find` semantics) and stops. A duplicate-name
 * collision is rare, and the consequence here is just "click navigates to the
 * other same-named channel" — not data loss — so this is an accepted,
 * documented simplification, not a bug.
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

  const server =
    directory.find((s) => s.id === parsed.server) ??
    directory.find((s) => s.name === parsed.server)
  if (!server) return null

  const channel =
    server.channels.find((c) => c.id === parsed.channel) ??
    server.channels.find((c) => c.name === parsed.channel)
  if (!channel) return null

  return {
    server,
    channel,
    ...(parsed.threadRootSeq !== undefined ? { threadRootSeq: parsed.threadRootSeq } : {}),
  }
}

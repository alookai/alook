import { parseRef } from "@alook/shared"

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
  channels: ChannelRefDirectoryChannel[]
}
export type ChannelRefDirectory = ChannelRefDirectoryServer[]

export type ResolvedChannelRef = {
  server: ChannelRefDirectoryServer
  channel: ChannelRefDirectoryChannel
  rootSeq?: number
  seq?: number
}

/**
 * Resolve a raw `/server/channel` (or `/server/channel/#N`) ref string
 * against an already-fetched client-side directory. UI-only: tries id
 * first, then exact name — the id fallback exists here because pill links
 * and in-window navigation store raw channel ids. Purely in-memory (no
 * network call) and no ambiguity error. The agent-facing resolver is
 * strictly name-only; this helper must not be used on agent code paths.
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
    ...(parsed.rootSeq !== undefined ? { rootSeq: parsed.rootSeq } : {}),
    ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
  }
}

/**
 * Resolve a bare `/server` ref (one segment, no channel — `parseRef` throws
 * on this shape since it requires `/<server>/<channel>`) against the
 * already-fetched directory. UI-only: id-then-exact-name lookup with the
 * same duplicate-name simplification as `resolveChannelRefBase` — see that
 * function's doc comment. Not for agent code paths.
 */
export function resolveServerRefBase(
  directory: ChannelRefDirectory,
  ref: string,
): ChannelRefDirectoryServer | null {
  if (!ref.startsWith("/")) return null
  const body = ref.slice(1)
  if (!body || body.includes("/")) return null

  return (
    directory.find((s) => s.id === body) ??
    directory.find((s) => s.name === body) ??
    null
  )
}

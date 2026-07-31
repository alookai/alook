/**
 * Client-side "directory" of every channel-ref-resolvable server + channel —
 * built from already-fetched data (see `use-channel-ref-directory.ts`), not
 * a fresh fetch per ref. Scoped to whatever servers/channels the client
 * already has loaded.
 *
 * This is the id→live-name lookup source behind the `{}()` ref-token pill
 * (`ref-token-pill.tsx` via `useChannelRefDirectory`). It MAY hold raw ids
 * (the token carries the authoritative id). The agent-facing resolver
 * (`resolveChannelByNameForMember`) does NOT accept ids — do not use this
 * directory on agent code paths.
 *
 * (The legacy `resolveChannelRefBase`/`resolveServerRefBase` string resolvers
 * that once lived here were removed with ref/id decision B — the bare
 * `/server/channel` pill they backed no longer exists; only the token pill
 * renders now, and it looks a name up by id off this same directory.)
 */
type ChannelRefDirectoryChannel = { id: string; name: string }
type ChannelRefDirectoryServer = {
  id: string
  name: string
  channels: ChannelRefDirectoryChannel[]
}
export type ChannelRefDirectory = ChannelRefDirectoryServer[]

import { NextResponse } from "next/server"
import { queries, parseRef, DM_SERVER, parseNameAndTag } from "@alook/shared"
import type { Database } from "@alook/shared"
import { isUniqueConstraintError } from "@alook/shared"
import { guardDmOpen } from "./dm-guard"
import { isDmTarget } from "./message-handler"
import { requireChannelMember, requireDMAccess } from "./permissions"

export type TargetResolution =
  | { kind: "channel"; channelId: string }
  | { kind: "dm"; channelId: string; otherUserId: string }
  | { error: 400 | 403 | 404; message: string; hint?: Array<{ id: string; path: string }> }

export interface ResolveTargetOpts {
  /** `send` only — auto-creates the DM row (guarded by `guardDmOpen`) if missing. */
  createDmIfMissing?: boolean
  /** `send` only — auto-creates the thread channel row if missing. */
  createThreadIfMissing?: boolean
  /** Threaded into `guardDmOpen` when `createDmIfMissing` — default "human". */
  callerKind?: "human" | "bot"
}

/**
 * Resolve a CLI path ref (`ChannelRef`, e.g. `/studio/general`,
 * `/studio/general/#42`, `/.dm/gusye#1231`) to a concrete channel/DM id,
 * scoped to `userId`'s memberships. Threads flatten to `{ kind: "channel",
 * channelId: <thread's own id> }` (debt #10 — threads ARE channels); the
 * caller (the `send` route) is responsible for reconstructing the full
 * `MessageTarget` (`kind: "thread"` with `parentChannelId`) before calling
 * `createCommunityMessage` — see plan §5's "MessageTarget reconstruction"
 * note, this function intentionally does NOT do that itself.
 *
 * Channel names are unique per server for top-level channels (migration
 * 0057's partial-unique index `idx_channel_server_name`) — the resolver
 * enforces the same invariant by matching only where `parentChannelId IS
 * NULL`. Threads and forum posts are unreachable from this helper by name
 * or id; use the canonical `#seq` grammar to descend into a thread. Server
 * NAME ambiguity is still possible (server names are non-unique) and still
 * returns `{ error: 400, hint: [...] }` so the agent can pick.
 * `createDmIfMissing`/`createThreadIfMissing` are both `true` for `send`
 * only — every other route passes `false` so a stale ref never materializes
 * a DM/thread row as a side effect of a read.
 */
export async function resolveTargetForMember(
  db: Database,
  userId: string,
  ref: string,
  opts?: ResolveTargetOpts
): Promise<TargetResolution> {
  let parsed: ReturnType<typeof parseRef>
  try {
    parsed = parseRef(ref)
  } catch {
    return { error: 400, message: "malformed channel ref" }
  }

  // Message-pin form (`/server/channel#N`) has no use in this API surface —
  // every endpoint that needs to pin a message takes a separate `seq` field
  // (`resolve`, `read`). Reject rather than silently ignoring the `#N`.
  if (parsed.seq !== undefined) {
    return { error: 400, message: "channel ref must not pin a specific message (#N) — use a separate seq field" }
  }

  if (parsed.server === DM_SERVER) {
    if (parsed.threadRootSeq !== undefined) {
      // DM messages have no channelId, so they can't be a thread's
      // parentChannelId (community_channel.parentChannelId always
      // references another community_channel) — not modeled today.
      return { error: 404, message: "DM threads are not supported" }
    }

    const handle = parseNameAndTag(parsed.channel)
    if (!handle) {
      return { error: 400, message: "invalid DM handle, expected name#0042" }
    }
    const peer = await queries.user.getUserByNameAndDiscriminator(db, handle.name, handle.discriminator)
    if (!peer) {
      return { error: 404, message: "user not found" }
    }
    const peerId = peer.id

    if (opts?.createDmIfMissing) {
      const guard = await guardDmOpen(db, userId, peerId, { callerKind: opts.callerKind })
      if (!guard.ok) return { error: guard.status, message: guard.error }
      const dm = await queries.communityDm.createOrGetDM(db, { userId1: userId, userId2: peerId })
      return { kind: "dm", channelId: dm.id, otherUserId: peerId }
    }

    const dm = await queries.communityDm.getDMBetween(db, userId, peerId)
    if (!dm) return { error: 404, message: "dm not found" }
    return { kind: "dm", channelId: dm.id, otherUserId: peerId }
  }

  // Channel form: resolve server, then channel, both scoped to membership.
  const servers = await queries.communityServer.resolveServerByNameForMember(db, userId, parsed.server)
  if (servers.length === 0) return { error: 404, message: `server not found: ${parsed.server}` }
  if (servers.length > 1) {
    return {
      error: 400,
      message: "ambiguous server name",
      hint: servers.map((s) => ({ id: s.id, path: `/${s.id}/${parsed.channel}` })),
    }
  }
  const serverId = servers[0]!.id

  const matches = await queries.communityChannel.resolveChannelByNameForMember(db, serverId, userId, parsed.channel)
  if (matches.length === 0) return { error: 404, message: `channel not found: ${parsed.channel}` }
  const channel = matches[0]!

  // Forum-post form (`/server/forum/post`) — the resolved `channel` is the
  // parent forum; descend to the `forum_post` child by name. Runs parallel to
  // the thread branch below (do NOT fold them: a thread anchors on a root-msg
  // seq, a post on its own name). Post names are NOT unique within a forum, so
  // >1 match is an ambiguous ref — return 400 + candidates, NEVER silently pick
  // one (mirrors the ambiguous-server-name behavior above). A forum post
  // inherits its forum's access; `requireChannelMember`/`requireChannelAccess`
  // at the call site climb `parentChannelId` to gate on the forum's roster.
  if (parsed.childChannelName !== undefined) {
    const posts = await queries.communityChannel.getChildChannelByName(db, channel.id, parsed.childChannelName)
    if (posts.length === 0) {
      return { error: 404, message: `post not found: ${parsed.childChannelName}` }
    }
    if (posts.length > 1) {
      // Ambiguous: >1 post shares this name (only possible for legacy dupes
      // predating create-time dedup). The red line is met by refusing — we
      // NEVER silently pick one. A name-based hint can't disambiguate here
      // (the candidates' name-anchor paths are identical), so we report the
      // count instead of fabricating useless identical paths; a one-time
      // slug-dedup migration on legacy posts is the clean fix (deferred).
      return {
        error: 400,
        message: `ambiguous post name "${parsed.childChannelName}" in ${parsed.channel} — ${posts.length} posts share this name; rename the duplicates to address them by name`,
      }
    }
    return { kind: "channel", channelId: posts[0]!.id }
  }

  if (parsed.threadRootSeq === undefined) {
    return { kind: "channel", channelId: channel.id }
  }

  // Defense in depth: a thread may only root on a TOP-LEVEL channel — never
  // on a forum post or another thread (that grandchild would defeat the
  // single-level privacy anchor climb and leak a private forum's thread
  // server-wide). This branch is provably unreachable via the current name
  // resolver (`resolveChannelByNameForMember` filters `parent_channel_id IS
  // NULL`, so `channel.parentChannelId` is always null here); it stays as a
  // guard against future changes that widen that resolver, and mirrors what
  // `createThreadChannel` enforces at the DB layer as a last resort.
  if (channel.parentChannelId) {
    return { error: 400, message: "can't start a thread inside a thread or forum post" }
  }

  // Thread form (`/server/channel/#N`) — translate the root seq to the
  // parent message's id, then find (or create) the thread's own channel row.
  const rootMessage = await queries.communityMessage.getMessageByChannelAndSeq(
    db,
    { channelId: channel.id },
    parsed.threadRootSeq
  )
  if (!rootMessage || parsed.threadRootSeq === 0) {
    return { error: 404, message: `no message with seq #${parsed.threadRootSeq} in this channel` }
  }

  const existingThread = await queries.communityChannel.getThreadChannelByParentMessage(
    db,
    channel.id,
    rootMessage.id
  )
  if (existingThread) return { kind: "channel", channelId: existingThread.id }

  if (!opts?.createThreadIfMissing) {
    return { error: 404, message: "thread not found" }
  }

  try {
    const created = await queries.communityChannel.createThreadChannel(db, channel.id, rootMessage.id, userId)
    return { kind: "channel", channelId: created.id }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Lost the race to a concurrent thread-create — re-select the winner.
      const winner = await queries.communityChannel.getThreadChannelByParentMessage(db, channel.id, rootMessage.id)
      if (winner) return { kind: "channel", channelId: winner.id }
    }
    throw err
  }
}

/**
 * id-first sibling of `resolveTargetForMember` (ref/id coexistence, PR-2). A
 * bot that already holds a `channelId` (from the read-side `{id, ref}` or a
 * body `{label}(channel/id)` ref) skips ref parsing and addresses by id
 * directly. Returns the SAME `TargetResolution` union so every action route
 * branches on one line: `body.channelId ? resolveTargetById(...) :
 * resolveTargetForMember(...)`.
 *
 * Critically this is NOT a bare id lookup: `resolveTargetForMember` fused three
 * jobs — ref→id, membership authorization (its `...ForMember` scoping 404s a
 * non-member), and DM/channel discrimination. Skipping ref parsing must NOT
 * skip the other two, or a bot could address a channel it isn't in by passing
 * a raw id (the class of the phase-1 DM block-bypass). So this path re-runs
 * both: discriminate DM vs channel from the channel row's type (the same
 * `type === "dm"` criterion `isDmTarget` keys on — no divergent DM test), then
 * gate through `requireDMAccess` (DM — also enforces the block check) /
 * `requireChannelMember` (channel). A non-member is rejected exactly as the ref
 * path rejects them; a missing/unknown id 404s (aligned with a missing ref).
 * Never auto-creates (no DM/thread materialization) — an id names an existing
 * row by definition.
 */
export async function resolveTargetById(
  db: Database,
  userId: string,
  channelId: string
): Promise<TargetResolution> {
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return { error: 404, message: `channel not found: ${channelId}` }

  if (isDmTarget(channel.type)) {
    const gate = await requireDMAccess(db, channelId, userId)
    if (!gate.ok) return { error: gate.status as 400 | 403 | 404, message: gate.error }
    return { kind: "dm", channelId, otherUserId: gate.value.otherUserId }
  }

  const gate = await requireChannelMember(db, channelId, userId)
  if (!gate.ok) return { error: gate.status as 400 | 403 | 404, message: gate.error }
  return { kind: "channel", channelId }
}

/**
 * Convert a `resolveTargetForMember` error branch into the JSON error
 * response every agent route returns for it — shared so `send`/`ack`/`read`/
 * `resolve` don't each hand-roll the `{ error, hint? }` shape independently.
 * Callers narrow `resolved` to the error branch (`"error" in resolved`)
 * before calling this.
 */
export function resolveErrorResponse(
  resolved: Extract<TargetResolution, { error: 400 | 403 | 404 }>
): NextResponse {
  return NextResponse.json(
    { error: resolved.message, ...(resolved.hint ? { hint: resolved.hint } : {}) },
    { status: resolved.error }
  )
}

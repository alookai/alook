import { NextResponse } from "next/server"
import { queries, parseRef, DM_SERVER, parseNameAndTag, channelCreation, withD1Retry } from "@alook/shared"
import type { Database } from "@alook/shared"
import { guardDmOpen } from "./dm-guard"
import { createWithCollisionPolicy } from "./create-collision"

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
 * NULL`. A thread is unreachable from this helper by name or id; use the
 * canonical `#seq` grammar to descend into one. Server
 * Real-server refs require a unique name#discriminator handle. Bare server
 * names are rejected; internal server ids remain accepted by the scoped query.
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
  const servers = await withD1Retry(
    () => queries.communityServer.resolveServerByNameForMember(db, userId, parsed.server),
    { route: "community/resolve-ref:server" }
  )
  if (servers.length === 0) return { error: 404, message: "server not found" }
  const serverId = servers[0]!.id

  const matches = await withD1Retry(
    () => queries.communityChannel.resolveChannelByNameForMember(db, serverId, userId, parsed.channel),
    { route: "community/resolve-ref:channel" }
  )
  if (matches.length === 0) return { error: 404, message: `channel not found: ${parsed.channel}` }
  const channel = matches[0]!

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
  const rootMessage = await withD1Retry(
    () => queries.communityMessage.getMessageByChannelAndSeq(
      db,
      { channelId: channel.id },
      parsed.threadRootSeq!
    ),
    { route: "community/resolve-ref:root-message" }
  )
  if (!rootMessage || parsed.threadRootSeq === 0) {
    return { error: 404, message: `no message with seq #${parsed.threadRootSeq} in this channel` }
  }

  const existingThread = await withD1Retry(
    () => queries.communityChannel.getThreadChannelByParentMessage(db, channel.id, rootMessage.id),
    { route: "community/resolve-ref:thread" }
  )
  if (existingThread) return { kind: "channel", channelId: existingThread.id }

  if (!opts?.createThreadIfMissing) {
    return { error: 404, message: "thread not found" }
  }

  // Thread create via the shared trait-keyed collision policy (B4): thread's
  // creation trait is get-or-create — a concurrent create that loses the race on
  // the parent_message_id anchor (unique index, migration 0052) re-selects the
  // winner rather than making a second thread. Top-level channels
  // (reject-on-collision) use the same dispatch with a different collision
  // contract; only these callbacks (the thread channel-shape + its anchor
  // refetch) are thread-specific. DM's identity-collision is a different key
  // space and is NOT wired here.
  const threadResult = await createWithCollisionPolicy(channelCreation("thread"), {
    attempt: () => queries.communityChannel.createThreadChannel(db, channel.id, rootMessage.id, userId),
    refetchWinner: () => queries.communityChannel.getThreadChannelByParentMessage(db, channel.id, rootMessage.id),
  })
  // get-or-create never returns a structured failure (it creates or re-selects
  // the winner, else throws) — a `!ok` here is unreachable for this policy;
  // map it to a 404 rather than widen TargetResolution's error union to 409.
  if (!threadResult.ok) return { error: 404, message: "thread not found" }
  return { kind: "channel", channelId: threadResult.value.id }
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

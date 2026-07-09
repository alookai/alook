import { NextResponse } from "next/server"
import { queries, parseRef, DM_SERVER, parseNameAndTag } from "@alook/shared"
import type { Database } from "@alook/shared"
import { isUniqueConstraintError } from "@alook/shared"
import { guardDmOpen } from "./dm-guard"

export type TargetResolution =
  | { kind: "channel"; channelId: string }
  | { kind: "dm"; dmConversationId: string; otherUserId: string }
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
 * Ambiguity (debt #5) is not a hard error: if a server/channel NAME matches
 * more than one candidate, this returns `{ error: 400, hint: [...] }` so the
 * agent can pick. `createDmIfMissing`/`createThreadIfMissing` are both
 * `true` for `send` only — every other route passes `false` so a stale ref
 * never materializes a DM/thread row as a side effect of a read.
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
      return { kind: "dm", dmConversationId: dm.id, otherUserId: peerId }
    }

    const dm = await queries.communityDm.getDMBetween(db, userId, peerId)
    if (!dm) return { error: 404, message: "dm not found" }
    return { kind: "dm", dmConversationId: dm.id, otherUserId: peerId }
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

  const channels = await queries.communityChannel.resolveChannelByNameForMember(db, serverId, userId, parsed.channel)
  if (channels.length === 0) return { error: 404, message: `channel not found: ${parsed.channel}` }
  if (channels.length > 1) {
    return {
      error: 400,
      message: "ambiguous channel name",
      hint: channels.map((c) => ({ id: c.id, path: `/${serverId}/${c.id}` })),
    }
  }
  const channel = channels[0]!

  if (parsed.threadRootSeq === undefined) {
    return { kind: "channel", channelId: channel.id }
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

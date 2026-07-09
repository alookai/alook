/**
 * Server-side fan-out helpers for community real-time events.
 *
 * Each function resolves the recipient set via D1 queries,
 * then POSTs the event to each user's per-user DO via the existing
 * broadcast service binding (WS_DO_WORKER -> /broadcast/user/<userId>).
 *
 * Uses the same `broadcastToUser` function that existing code uses,
 * ensuring consistent service-binding -> HTTP fallback behavior.
 *
 * Contract: these helpers absorb all failures internally and never reject.
 * Routes call them as fire-and-forget statements without `.catch()`.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, createLogger, WS_EVENTS } from "@alook/shared"
import type { CommunityWsEvent, Database } from "@alook/shared"
import { getDb } from "../db"
import { broadcastToUser } from "../broadcast"
import { enqueueBotWakes, type WakeMessageRow } from "./wake-producer"

const log = createLogger({ service: "community-fanout" })

type BroadcastableEvent = CommunityWsEvent & { type: string }

/**
 * Passed by `message-handler.ts` alongside a `MESSAGE_CREATE` event so
 * `fanOutToChannel`/`fanOutToDM` can trigger the push-wake pipeline (plan
 * §8) using the SAME recipient list already resolved for the human-WS
 * broadcast, instead of re-querying membership a second time. Omitted (or
 * event.type !== MESSAGE_CREATE) → no wake dispatch, e.g.
 * `CHILD_CHANNEL_UPDATE` never wakes anyone.
 */
type WakeOpts = { wakeMessageRow?: WakeMessageRow }

/**
 * Resolves all member user IDs for a server.
 */
async function getServerMemberUserIds(db: Database, serverId: string): Promise<string[]> {
  return queries.communityMember.listMemberUserIds(db, serverId)
}

/**
 * Resolves the server a channel belongs to, then returns all member user IDs.
 */
async function getChannelRecipientUserIds(db: Database, channelId: string): Promise<string[]> {
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) {
    log.warn("fanOutToChannel: channel not found", { channelId })
    return []
  }
  return getServerMemberUserIds(db, channel.serverId)
}

/**
 * Fan out an event to all members of the server that owns a channel.
 */
export async function fanOutToChannel(
  channelId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string } & WakeOpts
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const userIds = await getChannelRecipientUserIds(db, channelId)
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
    maybeEnqueueWakes(event, userIds, { channelId }, opts)
  } catch (err) {
    log.warn("fanout_to_channel_failed", {
      eventType: event.type,
      targetId: channelId,
      err: String(err),
    })
  }
}

/**
 * Fan out an event to both participants of a DM conversation.
 */
export async function fanOutToDM(
  dmConversationId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string } & WakeOpts
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const dm = await queries.communityDm.getDM(db, dmConversationId)
    if (!dm) {
      log.warn("fanOutToDM: DM conversation not found", { dmConversationId })
      return
    }
    const userIds = [dm.user1Id, dm.user2Id].filter(Boolean) as string[]
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
    maybeEnqueueWakes(event, userIds, { dmConversationId }, opts)
  } catch (err) {
    log.warn("fanout_to_dm_failed", {
      eventType: event.type,
      targetId: dmConversationId,
      err: String(err),
    })
  }
}

/**
 * Wake dispatch only fires for real new-message events (plan §8) — reactions,
 * edits, pins, `CHILD_CHANNEL_UPDATE`, etc. never wake anyone. The sender is
 * excluded via the SAME `excludeUserId` the human-WS broadcast already used
 * (a bot never wakes itself off its own send). Never throws — `enqueueBotWakes`
 * owns its own error handling via `ctx.waitUntil`; this is best-effort on top.
 */
function maybeEnqueueWakes(
  event: BroadcastableEvent,
  recipients: string[],
  scope: { channelId: string } | { dmConversationId: string },
  opts?: { excludeUserId?: string } & WakeOpts
): void {
  if (event.type !== WS_EVENTS.MESSAGE_CREATE || !opts?.wakeMessageRow) return
  const filtered = opts.excludeUserId ? recipients.filter((id) => id !== opts.excludeUserId) : recipients
  enqueueBotWakes({
    recipients: filtered,
    ...scope,
    messageRow: opts.wakeMessageRow,
  }).catch((err) => {
    log.warn("enqueue_bot_wakes_from_fanout_failed", { err: String(err) })
  })
}


/**
 * Fan out an event to all members of a server.
 */
export async function fanOutToServerMembers(
  serverId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string }
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const userIds = await getServerMemberUserIds(db, serverId)
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
  } catch (err) {
    log.warn("fanout_to_server_members_failed", {
      eventType: event.type,
      targetId: serverId,
      err: String(err),
    })
  }
}

/**
 * Safe wrapper around `broadcastToUser` for community routes: never rejects,
 * logs on failure. Non-community callers keep the direct throwing contract.
 */
export async function broadcastToUserSafe(
  userId: string,
  event: BroadcastableEvent,
): Promise<void> {
  try {
    await broadcastToUser(userId, event)
  } catch (err) {
    log.warn("broadcast_to_user_failed", {
      eventType: event.type,
      targetId: userId,
      err: String(err),
    })
  }
}

/**
 * Internal: broadcast a community event to a list of user IDs.
 * Optionally excludes a specific user (e.g., the event author).
 */
async function broadcastToRecipients(
  userIds: string[],
  event: BroadcastableEvent,
  excludeUserId?: string
): Promise<void> {
  const recipients = excludeUserId
    ? userIds.filter((id) => id !== excludeUserId)
    : userIds

  if (recipients.length === 0) return

  // Fire all broadcasts concurrently — non-blocking via waitUntil in broadcastToUser
  const promises = recipients.map((userId) =>
    broadcastToUser(userId, event).catch((err) => {
      log.warn("broadcastToRecipient failed", { userId, type: event.type, err: String(err) })
    })
  )
  await Promise.all(promises)
}

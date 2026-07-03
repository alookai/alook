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
import { createDb, queries, createLogger } from "@alook/shared"
import type { CommunityWsEvent } from "@alook/shared"
import { broadcastToUser } from "../broadcast"

const log = createLogger({ service: "community-fanout" })

type BroadcastableEvent = CommunityWsEvent & { type: string }

/**
 * Resolves all member user IDs for a server.
 */
async function getServerMemberUserIds(db: ReturnType<typeof createDb>, serverId: string): Promise<string[]> {
  return queries.communityMember.listMemberUserIds(db, serverId)
}

/**
 * Resolves the server a channel belongs to, then returns all member user IDs.
 */
async function getChannelRecipientUserIds(db: ReturnType<typeof createDb>, channelId: string): Promise<string[]> {
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
  opts?: { excludeUserId?: string }
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = createDb((env as Env).DB)
    const userIds = await getChannelRecipientUserIds(db, channelId)
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
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
  opts?: { excludeUserId?: string }
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = createDb((env as Env).DB)
    const dm = await queries.communityDm.getDM(db, dmConversationId)
    if (!dm) {
      log.warn("fanOutToDM: DM conversation not found", { dmConversationId })
      return
    }
    const userIds = [dm.user1Id, dm.user2Id].filter(Boolean) as string[]
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
  } catch (err) {
    log.warn("fanout_to_dm_failed", {
      eventType: event.type,
      targetId: dmConversationId,
      err: String(err),
    })
  }
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
    const db = createDb((env as Env).DB)
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

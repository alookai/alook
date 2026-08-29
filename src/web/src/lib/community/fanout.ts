/**
 * Server-side fan-out helpers for community real-time events.
 *
 * Each function resolves the recipient set via D1 queries,
 * then sends one bounded bulk request through the existing broadcast
 * service binding (WS_DO_WORKER -> /broadcast/users).
 *
 * The bulk helper uses the same service-binding -> HTTP fallback behavior
 * as the compatibility single-user helper.
 *
 * Contract: these helpers absorb all failures internally and never reject.
 * Routes call them as fire-and-forget statements without `.catch()`.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, createLogger, WS_EVENTS, withD1Retry } from "@alook/shared"
import type { CommunityWsEvent, Database } from "@alook/shared"
import { getDb } from "../db"
import { broadcastToUser, broadcastToUsers } from "../broadcast"

const log = createLogger({ service: "community-fanout" })

type BroadcastableEvent = CommunityWsEvent & { type: string }

/**
 * Resolves all member user IDs for a server.
 */
async function getServerMemberUserIds(db: Database, serverId: string): Promise<string[]> {
  return queries.communityMember.listMemberUserIds(db, serverId)
}

/**
 * Resolves the recipient set for a channel event.
 *
 * - THREAD (`type="thread"`, including a post — a thread rooted directly
 *   under a forum) → the unit's NOTIFY set (its participant rows) — the
 *   notification dimension: message events reach only participants (join by
 *   spoke/mention/added), NOT the whole parent channel or server, and NOT
 *   admins (never auto-participants). A public post therefore doesn't blast
 *   the whole server, and a private post doesn't ping every roster member on
 *   every message — only the people actually involved.
 * - DM (`type="dm"`) → its two `relation='access'` members. A DM has
 *   `server_id = NULL`, so it must NOT fall through to the server-scoped
 *   resolver (which would query `server_id = NULL` and return an empty set).
 * - channel / forum → the access audience via the shared resolver
 *   (public/private split; a forum owns its roster like a text channel).
 *
 * The split lives here so fan-out and bot-wake use the same recipient set.
 */
async function getChannelRecipientUserIds(db: Database, channelId: string): Promise<string[]> {
  const retryRoute = {
    "channel-type": "fanout:channel-type",
    "thread-participants": "fanout:thread-participants",
    "dm-members": "fanout:dm-members",
    "scope-members": "fanout:scope-members",
  } as const
  return queries.communityMembersResolver.resolveChannelRecipientUserIds(
    db,
    channelId,
    (phase, query) => withD1Retry(query, { route: retryRoute[phase] }),
  )
}

/**
 * Fan out an event to all members of the server that owns a channel.
 */
export function fanOutToChannel(
  channelId: string,
  event: BroadcastableEvent,
  opts?: { recipients?: string[] }
): Promise<void> {
  try {
    const { env, ctx } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const work = (async () => {
      try {
        // Reuse a pre-resolved recipient set when the caller already resolved it
        // (message-handler shares one set between fan-out and the notify pipeline),
        // else resolve here.
        const userIds = opts?.recipients ?? await getChannelRecipientUserIds(db, channelId)
        await broadcastToRecipients(userIds, event)
      } catch (err) {
        log.warn("fanout_to_channel_failed", {
          eventType: event.type,
          targetId: channelId,
          err: String(err),
        })
      }
    })()
    // Callers deliberately fire-and-forget this helper. Keep the whole setup
    // alive from the first tick, including recipient resolution before the
    // leaf wake/broadcast operations register their own waitUntil promises.
    try { ctx.waitUntil(work) } catch { /* non-CF test/runtime context */ }
    return work
  } catch (err) {
    log.warn("fanout_to_channel_failed", {
      eventType: event.type,
      targetId: channelId,
      err: String(err),
    })
    return Promise.resolve()
  }
}

/**
 * Fan out an event to both access members of a DM channel (type=dm). DMs are
 * channels now — kept as a thin named wrapper for the DM call sites; the
 * recipient set is the channel's relation='access' members.
 */
export function fanOutToDM(
  channelId: string,
  event: BroadcastableEvent,
): Promise<void> {
  try {
    const { env, ctx } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const work = (async () => {
      try {
        const dm = await queries.communityDm.getDM(db, channelId)
        if (!dm) {
          log.warn("fanOutToDM: DM channel not found", { channelId })
          return
        }
        const userIds = await queries.communityChannel.listChannelMemberUserIds(db, channelId)
        await broadcastToRecipients(userIds, event)
      } catch (err) {
        log.warn("fanout_to_dm_failed", {
          eventType: event.type,
          targetId: channelId,
          err: String(err),
        })
      }
    })()
    try { ctx.waitUntil(work) } catch { /* non-CF test/runtime context */ }
    return work
  } catch (err) {
    log.warn("fanout_to_dm_failed", {
      eventType: event.type,
      targetId: channelId,
      err: String(err),
    })
    return Promise.resolve()
  }
}

/**
 * Resolves the audience for a self-authored profile change: co-members
 * (every server the user shares with someone) union friends. Mirrors
 * `ws-durable.ts`'s `getPresenceAudience` — that function lives in the
 * separate `ws-do` worker and isn't reachable from `src/web`'s API routes,
 * but it's built from the same two shared query functions used here.
 */
async function getProfileAudience(db: Database, userId: string): Promise<string[]> {
  const [coMembers, friends] = await Promise.all([
    queries.communityMember.getCoMemberUserIds(db, userId),
    queries.communityFriendship.getFriendUserIds(db, userId),
  ])
  return [...new Set([...coMembers, ...friends])]
}

async function getIdentityAudience(db: Database, userId: string): Promise<string[]> {
  const [coMembers, friends, dmPeers] = await Promise.all([
    queries.communityMember.getCoMemberUserIds(db, userId),
    queries.communityFriendship.getFriendUserIds(db, userId),
    queries.communityDm.listDmPeerUserIds(db, userId),
  ])
  return [...new Set([userId, ...coMembers, ...friends, ...dmPeers])]
}

export function fanOutIdentityUpdate(
  userId: string,
  avatar: string,
  avatarVersion: number,
): Promise<void> {
  try {
    const { env, ctx } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const work = (async () => {
      try {
        const audience = await getIdentityAudience(db, userId)
        await broadcastToRecipients(audience, {
          type: WS_EVENTS.IDENTITY_UPDATE,
          userId,
          avatar,
          avatarVersion,
        })
      } catch (error) {
        log.warn("fanout_identity_update_failed", {
          subjectId: userId,
          errorCategory: error instanceof Error ? error.name : "NonError",
        })
      }
    })()
    try { ctx.waitUntil(work) } catch { }
    return work
  } catch (error) {
    log.warn("fanout_identity_update_failed", {
      subjectId: userId,
      errorCategory: error instanceof Error ? error.name : "NonError",
    })
    return Promise.resolve()
  }
}

/**
 * Fan out a status change to everyone who can currently see the user
 * (server co-members + friends). Self is intentionally excluded from their
 * own audience — the caller updates the local WS store directly on save
 * success instead (see `setUserStatus` call sites in `shell-frame.tsx` /
 * `settings/user-settings.tsx`).
 */
export async function fanOutStatusUpdate(
  userId: string,
  statusEmoji: string | null,
  statusText: string | null,
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const audience = await getProfileAudience(db, userId)
    await broadcastToRecipients(audience, {
      type: WS_EVENTS.STATUS_UPDATE,
      userId,
      statusEmoji,
      statusText,
    })
  } catch (err) {
    log.warn("fanout_status_update_failed", { userId, err: String(err) })
  }
}

/**
 * Fan out an event to all members of a server.
 */
export function fanOutToServerMembers(
  serverId: string,
  event: BroadcastableEvent,
): Promise<void> {
  try {
    const { env, ctx } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    // Register the whole recipient-resolution + broadcast chain immediately.
    // Most mutation routes intentionally fire-and-forget this helper; without
    // an outer waitUntil the worker may finish after the D1 await but before
    // broadcastToUsers gets a chance to register its own lifetime promise.
    const work = (async () => {
      try {
        const userIds = await getServerMemberUserIds(db, serverId)
        await broadcastToRecipients(userIds, event)
      } catch (err) {
        log.warn("fanout_to_server_members_failed", {
          eventType: event.type,
          targetId: serverId,
          err: String(err),
        })
      }
    })()
    try { ctx.waitUntil(work) } catch { /* non-CF test/runtime context */ }
    return work
  } catch (err) {
    log.warn("fanout_to_server_members_failed", {
      eventType: event.type,
      targetId: serverId,
      err: String(err),
    })
    return Promise.resolve()
  }
}

export function fanOutToUsers(
  userIds: string[],
  event: BroadcastableEvent,
): Promise<void> {
  return broadcastToRecipients(userIds, event)
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
 */
async function broadcastToRecipients(
  userIds: string[],
  event: BroadcastableEvent,
): Promise<void> {
  if (userIds.length === 0) return
  try {
    await broadcastToUsers(userIds, event)
  } catch (err) {
    log.warn("broadcast_to_recipients_failed", {
      recipientCount: userIds.length,
      type: event.type,
      err: String(err),
    })
  }
}

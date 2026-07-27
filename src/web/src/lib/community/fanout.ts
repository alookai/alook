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
 * `fanOutToDM` can trigger the push-wake pipeline using the SAME recipient
 * list already resolved for the human-WS broadcast, instead of re-querying
 * membership a second time. Omitted (or event.type !== MESSAGE_CREATE) → no
 * wake dispatch.
 *
 * ⚠ DM-ONLY now (batch 3, R15). The CHANNEL wake folded into
 * `dispatchMessageNotify`'s level-filtered pipeline (`notify.ts`) — a channel
 * bot follows its own effective notification level. A DM has no `channelId`,
 * so no notification setting can key on it (mute is not in DM scope, O4);
 * DM wake therefore stays a direct `maybeEnqueueWakes` here, NOT routed
 * through the level filter (which would find no setting and be a no-op anyway,
 * but keeping it direct makes the "DM wake is never swallowed" invariant
 * explicit and testable).
 */
type WakeOpts = { wakeMessageRow?: WakeMessageRow }

/**
 * Resolves all member user IDs for a server.
 */
async function getServerMemberUserIds(db: Database, serverId: string): Promise<string[]> {
  return queries.communityMember.listMemberUserIds(db, serverId)
}

/**
 * Resolves the recipient set for a channel event. Delegates to the shared
 * `resolveChannelRecipientUserIds` (also used by ws-do's typing fan-out) so the
 * type→recipient rule (thread/post → participant set; channel/forum → access
 * audience) lives in one place and can never drift across workers.
 */
async function getChannelRecipientUserIds(db: Database, channelId: string): Promise<string[]> {
  return queries.communityMembersResolver.resolveChannelRecipientUserIds(db, channelId)
}

/**
 * Fan out an event to all recipients of a channel.
 *
 * `opts.recipients`, when supplied, is used AS-IS and no membership query runs
 * — this lets `message-handler.ts` resolve the recipient set ONCE and share it
 * between the `MESSAGE_CREATE` broadcast here and the level-filtered notify
 * pipeline (`dispatchMessageNotify`), without a second query or blocking the
 * send response on broadcast completion. Every other caller omits it and gets
 * the internal resolution.
 *
 * ⚠ R1 — `MESSAGE_CREATE` broadcast stays HERE and is NEVER level-filtered.
 * ⚠ Channel bot-wake moved OUT of here into `dispatchMessageNotify` (batch 3):
 * a channel bot follows its own effective notification level. This function no
 * longer enqueues wakes; only `fanOutToDM` still does (DM isn't in mute scope).
 */
export async function fanOutToChannel(
  channelId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string; recipients?: string[] }
): Promise<void> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    const userIds = opts?.recipients ?? (await getChannelRecipientUserIds(db, channelId))
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
 * Resolve the recipient user ids for a channel event without broadcasting —
 * the shared type→recipient rule (thread/post → participants; channel/forum →
 * access audience). `message-handler.ts` calls this once per send so the same
 * set feeds both the `MESSAGE_CREATE` fan-out and the notify pipeline. Absorbs
 * failures (returns []) like the other helpers here.
 */
export async function resolveChannelRecipients(channelId: string): Promise<string[]> {
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    return await getChannelRecipientUserIds(db, channelId)
  } catch (err) {
    log.warn("resolve_channel_recipients_failed", { targetId: channelId, err: String(err) })
    return []
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
 * DM wake dispatch (R15) — only fires for real new-message events; reactions,
 * edits, etc. never wake anyone. The sender is excluded via the SAME
 * `excludeUserId` the human-WS broadcast already used (a bot never wakes itself
 * off its own send). Never throws — `enqueueBotWakes` owns its own error
 * handling via `ctx.waitUntil`; this is best-effort on top.
 *
 * ⚠ DM-ONLY. The channel wake path folded into `dispatchMessageNotify`'s
 * level-filtered pipeline (batch 3). DM keeps a direct enqueue because a DM has
 * no `channelId` for a notification setting to key on — mute is not in DM scope
 * (O4), so routing DM wake through the level filter would be a no-op at best
 * and a swallowed wake at worst. Keeping it here makes "DM bot wake is never
 * swallowed by the mute pipeline" an explicit, testable invariant.
 */
function maybeEnqueueWakes(
  event: BroadcastableEvent,
  recipients: string[],
  scope: { dmConversationId: string },
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

/**
 * Fan out a status change to everyone who can currently see the user
 * (server co-members + friends). Self is intentionally excluded from their
 * own audience — the caller updates the local WS store directly on save
 * success instead (see `setUserStatus` call sites in `shell-frame.tsx` /
 * `edit-profile-dialog.tsx`).
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

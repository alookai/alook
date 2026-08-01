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
import { queries, createLogger, withD1Retry, WS_EVENTS, isThread, isForumPost, isDm } from "@alook/shared"
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
type WakeOpts = { wakeMessageRow?: WakeMessageRow; mentionedUserIds?: string[] }

/**
 * Resolves all member user IDs for a server.
 */
async function getServerMemberUserIds(db: Database, serverId: string): Promise<string[]> {
  return queries.communityMember.listMemberUserIds(db, serverId)
}

/**
 * Resolves the recipient set for a channel event.
 *
 * - THREAD (`type="thread"`) or FORUM_POST (`type="forum_post"`) → the unit's
 *   NOTIFY set (its participant rows). Both are the notification dimension:
 *   message events reach only participants (join by spoke/mention/added), NOT
 *   the whole parent channel or server, and NOT admins (never auto-participants).
 *   A public post therefore no longer blasts the whole server, and a private
 *   post no longer pings every roster member on every message — only the people
 *   actually involved. Nested-membership model.
 * - DM (`type="dm"`) → its two `relation='access'` members. A DM has
 *   `server_id = NULL`, so it must NOT fall through to the server-scoped
 *   resolver (which would query `server_id = NULL` and return an empty set).
 * - channel / forum → the access audience via the shared resolver
 *   (public/private split; a forum owns its roster like a text channel).
 *
 * The split lives here so fan-out and bot-wake use the same recipient set.
 */
async function getChannelRecipientUserIds(db: Database, channelId: string): Promise<string[]> {
  const rows = await queries.communityChannel.getChannelType(db, channelId)
  if (isThread(rows) || isForumPost(rows)) {
    return queries.communityThread.listThreadParticipantUserIds(db, channelId)
  }
  if (isDm(rows)) {
    return queries.communityChannel.listChannelMemberUserIds(db, channelId)
  }
  return queries.communityMembersResolver.resolveScopeMemberUserIds(db, {
    scope: "channel",
    scopeId: channelId,
  })
}

/**
 * Public wrapper so `message-handler` can resolve a channel's recipient set
 * ONCE and share it between the unfiltered `MESSAGE_CREATE` fan-out and the
 * level-filtered notify pipeline (no second membership query). Same split as
 * `getChannelRecipientUserIds` (thread/forum_post → participants; dm → access
 * members; channel/forum → scope audience).
 */
export async function resolveChannelRecipients(db: Database, channelId: string): Promise<string[]> {
  return getChannelRecipientUserIds(db, channelId)
}

/**
 * Fan out an event to all members of the server that owns a channel.
 */
export async function fanOutToChannel(
  channelId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string; recipients?: string[] } & WakeOpts
): Promise<void> {
  // Phase 1 — resolve the recipient set. This D1 read is the FALSE-NEGATIVE
  // risk (read-500 triage / swallow-class): with no recipient list we can
  // neither broadcast nor enqueue wakes, so a silent failure here = a message
  // that reaches nobody with no signal. `withD1Retry` retries the transient
  // whitelist to the true list; a still-escaping error (retry-exhausted or a
  // logic error) is surfaced OBSERVABLY (`log.error` + its own category)
  // instead of riding the broadcast's best-effort warn. The human-WS side
  // self-heals on reconnect-refetch (use-community-ws.ts `handleReconnect`),
  // so this stays observe-only — the function keeps its never-reject contract
  // for its fire-and-forget callers.
  let userIds: string[]
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    // Reuse a pre-resolved recipient set when the caller already resolved it
    // (message-handler shares one set between fan-out and the notify pipeline),
    // else resolve here (retry-armored).
    userIds =
      opts?.recipients ??
      (await withD1Retry(() => getChannelRecipientUserIds(db, channelId), {
        route: "fanout/channel-recipients",
      }))
  } catch (err) {
    log.error("fanout_channel_recipients_failed", {
      category: "fanout_channel_recipients_failed",
      eventType: event.type,
      targetId: channelId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return
  }

  // Phase 2 — broadcast + wake are best-effort side effects on a RESOLVED
  // recipient set. Their own failures are handled internally
  // (`broadcastToRecipients` per-user catch; `enqueueBotWakes` owns its
  // `waitUntil` catch), and this warn must not mask the phase-1 read.
  try {
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
 * Fan out an event to both access members of a DM channel (type=dm). DMs are
 * channels now — kept as a thin named wrapper for the DM call sites; the
 * recipient set is the channel's relation='access' members.
 */
export async function fanOutToDM(
  channelId: string,
  event: BroadcastableEvent,
  opts?: { excludeUserId?: string } & WakeOpts
): Promise<void> {
  // Phase 1 — resolve the recipient set (retry-armored, observable on failure;
  // same false-negative rationale as `fanOutToChannel`). The `getDM`
  // not-found check is a LOGIC guard, not a transient — a missing DM legitimately
  // means "nobody to fan out to", so it stays a warn+return inside the retried
  // read (a null result, not a thrown transient).
  let userIds: string[]
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    userIds = await withD1Retry(
      async () => {
        const dm = await queries.communityDm.getDM(db, channelId)
        if (!dm) {
          log.warn("fanOutToDM: DM channel not found", { channelId })
          return null
        }
        return queries.communityChannel.listChannelMemberUserIds(db, channelId)
      },
      { route: "fanout/dm-recipients" },
    ) ?? []
    if (userIds.length === 0) return
  } catch (err) {
    log.error("fanout_dm_recipients_failed", {
      category: "fanout_dm_recipients_failed",
      eventType: event.type,
      targetId: channelId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return
  }

  // Phase 2 — best-effort broadcast + wake on the resolved set.
  try {
    await broadcastToRecipients(userIds, event, opts?.excludeUserId)
    maybeEnqueueWakes(event, userIds, { channelId }, opts)
  } catch (err) {
    log.warn("fanout_to_dm_failed", {
      eventType: event.type,
      targetId: channelId,
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
  scope: { channelId: string },
  opts?: { excludeUserId?: string } & WakeOpts
): void {
  if (event.type !== WS_EVENTS.MESSAGE_CREATE || !opts?.wakeMessageRow) return
  const filtered = opts.excludeUserId ? recipients.filter((id) => id !== opts.excludeUserId) : recipients
  enqueueBotWakes({
    recipients: filtered,
    ...scope,
    messageRow: opts.wakeMessageRow,
    mentionedUserIds: opts.mentionedUserIds,
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
  // Phase 1 — resolve the audience (retry-armored, observable on failure).
  let audience: string[]
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    audience = await withD1Retry(() => getProfileAudience(db, userId), {
      route: "fanout/status-audience",
    })
  } catch (err) {
    log.error("fanout_status_audience_failed", {
      category: "fanout_status_audience_failed",
      userId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return
  }

  // Phase 2 — best-effort broadcast on the resolved audience.
  try {
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
  // Phase 1 — resolve the member set (retry-armored, observable on failure).
  let userIds: string[]
  try {
    const { env } = getCloudflareContext()
    const db = getDb((env as Env).DB)
    userIds = await withD1Retry(() => getServerMemberUserIds(db, serverId), {
      route: "fanout/server-members",
    })
  } catch (err) {
    log.error("fanout_server_members_failed", {
      category: "fanout_server_members_failed",
      eventType: event.type,
      targetId: serverId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return
  }

  // Phase 2 — best-effort broadcast on the resolved set.
  try {
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

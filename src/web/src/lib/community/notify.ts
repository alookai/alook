/**
 * Unified per-recipient message-notify pipeline (adapted from PR-408 batch 3,
 * commit 2b61535d, to main's post-#412 DM-as-channel model).
 *
 * ONE trunk for the HUMAN notify legs of a new message: resolve each
 * recipient's effective notification level, apply the 3-tier matrix, then
 * dispatch the mute-gated per-user signals — a `MENTION_CREATE` live push (when
 * that recipient was mentioned) and a per-user `UNREAD_BUMP` badge. Writes NO
 * persistent state — offline replay rides the existing `community_read_state`
 * cursors.
 *
 * Scope boundaries (Melly #23 ruling):
 * - This pipeline does NOT own bot WAKE. Wake gating lives in
 *   `wake-producer` (the produce/enqueue seam), gated by the SAME
 *   effective-level resolver. Keeping wake out of here keeps notify.ts to the
 *   human legs and avoids a double gate.
 * - This pipeline NEVER emits `MESSAGE_CREATE`. That broadcast is the ONLY
 *   content-sync path, stays in `fanOutToChannel`, and is unfiltered by level —
 *   so a user viewing their own muted channel still sees messages live, and a
 *   bot's `inbox pull` / `channel history` are never affected (mute ≠
 *   blindness).
 * - Mention ROWS (`createMentions`) are written by the caller, independent of
 *   this pipeline and NEVER level-gated — a `nothing` recipient's mention still
 *   persists and surfaces via inbox.
 *
 * The 3-tier matrix (bots and users, same predicate — Gener #28):
 *   level     plain msg (not mentioned)     mentioned
 *   all       badge                          badge + MENTION_CREATE push
 *   mentions  silent                         badge + MENTION_CREATE push
 *   nothing   silent                         silent (mention row still written)
 *
 * where "mentioned" = personal @ ∪ @everyone ∪ reply-to-me (the caller's full
 * mention set — @everyone counts, no split; Gener #28).
 */
import { queries, withD1Retry, WS_EVENTS, createLogger } from "@alook/shared"
import type { Database, NotificationLevelValue } from "@alook/shared"
import { broadcastToUser } from "../broadcast"

const log = createLogger({ service: "community-notify" })

export interface MessageNotifyContext {
  /**
   * Snapshot author name for the `MENTION_CREATE` payload. The author is
   * already excluded from `recipients`/`mentionedUserIds` upstream — this is
   * only the label mentioned users see.
   */
  authorName: string
}

/**
 * `true` when a recipient at `level` should receive the human notify legs for a
 * message where `wasMentioned` reflects whether THIS recipient was mentioned
 * (personal @ ∪ @everyone ∪ reply). Governs both badge and the mention push
 * uniformly.
 */
export function shouldDeliver(level: NotificationLevelValue, wasMentioned: boolean): boolean {
  if (level === "all") return true
  if (level === "mentions") return wasMentioned
  return false // "nothing" — never
}

/**
 * Dispatch level-filtered HUMAN notify signals for one just-created message.
 * Fire-and-forget: absorbs all failures (the message already synced via
 * `MESSAGE_CREATE`; a level-resolution blip must never fail the send).
 *
 * @param channelId  the message's channel scope. Every scope (channel, thread,
 *   forum_post, AND dm) resolves its per-recipient level here — there is NO
 *   channelId-nullness bypass (main's DMs are channels with a channelId; a DM's
 *   level is self-contained and defaults to `all`, so routing it through the
 *   resolver both honors an explicit per-DM mute and never inherits a
 *   server/parent `nothing`).
 * @param recipients  the fan-out recipient set (human + bot), already
 *   author-excluded — the SAME list resolved for the `MESSAGE_CREATE` broadcast.
 * @param mentionedUserIds  the full mention set (explicit @ ∪ @everyone
 *   expansion ∪ reply targets), already author-excluded — @everyone counts as a
 *   mention (Gener #28), no carve-out.
 */
export async function dispatchMessageNotify(
  db: Database,
  ctx: MessageNotifyContext,
  message: { id: string; channelId: string },
  recipients: string[],
  opts: {
    mentionedUserIds: string[]
    /** Server the message belongs to — rides the UNREAD_BUMP so the client
     * patches the right server tree/rail (inbox-dot-ws-driven). Undefined for
     * a DM (no server). From the caller's `target.serverId`, no extra query. */
    serverId?: string
    /** Sidebar-locatable row = `parentChannelId ?? channelId` (thread/forum-post
     * light the parent row). From the caller's target, no extra query. */
    railChannelId?: string
  },
): Promise<void> {
  try {
    const { channelId } = message
    const mentioned = new Set(opts.mentionedUserIds)

    const everyone = [...new Set([...recipients, ...opts.mentionedUserIds])]
    // `withD1Retry` (D1-armor: no-fallback notify-level read; retry to truth).
    const levels = await withD1Retry(
      () =>
        queries.communityNotificationSetting.resolveEffectiveLevelForUsers(db, everyone, channelId),
      { route: "notify/levels" },
    )
    const levelOf = (userId: string): NotificationLevelValue => levels.get(userId) ?? "all"

    // MENTION_CREATE live push — only to mentioned recipients whose level
    // delivers. A `nothing` mentioned recipient gets NO push, but their mention
    // ROW is still written by the caller.
    for (const userId of mentioned) {
      if (!shouldDeliver(levelOf(userId), true)) continue
      broadcastToUser(userId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId,
        messageId: message.id,
        channelId,
        authorName: ctx.authorName,
      }).catch(() => {})
    }

    // Per-user UNREAD_BUMP badge — per-recipient (A muted, B not), so it rides a
    // per-user event, not a flag on the shared MESSAGE_CREATE payload.
    for (const userId of recipients) {
      const isMention = mentioned.has(userId)
      if (!shouldDeliver(levelOf(userId), isMention)) continue
      broadcastToUser(userId, {
        type: WS_EVENTS.UNREAD_BUMP,
        userId,
        channelId,
        // serverId + railChannelId let the client patch the RIGHT server tree
        // and the right (parent, for threads) sidebar row; isMention splits
        // +mention vs +unread. All optional — a client on an older frame falls
        // back to channelId + current-server behavior.
        ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
        ...(opts.railChannelId !== undefined ? { railChannelId: opts.railChannelId } : {}),
        isMention,
      }).catch(() => {})
    }
  } catch (err) {
    log.warn("dispatch_message_notify_failed", {
      messageId: message.id,
      err: String(err),
    })
  }
}

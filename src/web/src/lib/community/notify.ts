/**
 * Unified message-notify pipeline (plan §14, batch 3).
 *
 * ONE trunk for "a new message is relevant to recipient X, give X a notify
 * signal": resolve each recipient's effective notification level, apply the
 * 3-tier matrix, then dispatch per transport — humans get a `MENTION_CREATE`
 * live push (when mentioned) + a per-user `UNREAD_BUMP` badge signal; bots get
 * a wake enqueue. Writes NO persistent event — offline replay rides the
 * existing `community_read_state` cursors (human `lastReadAt`, bot
 * `lastReadSeq`).
 *
 * ⚠ R1 — this pipeline NEVER emits `MESSAGE_CREATE`. That broadcast is the
 * ONLY content-sync path for an open channel and stays in `fanOutToChannel`,
 * unfiltered by level. Mute filters only wake enqueue, `MENTION_CREATE` live
 * push, and the badge/unread signal — content append is untouched, so a user
 * sitting in their own muted channel still sees new messages live.
 *
 * The 3-tier matrix (humans + bots, same rule):
 *   level     plain msg (no @)              mentioned
 *   all       notify (badge + wake)         notify + mention row
 *   mentions  silent                        notify + mention row
 *   nothing   silent                        NO notify/wake; mention row still
 *                                           written elsewhere (never here)
 *
 * ⇒ a recipient is delivered iff:
 *   level === "all"                       (plain or mentioned), OR
 *   level === "mentions" && wasMentioned
 * `nothing` never delivers. Mention ROWS are written by the caller
 * (`createMentions`), independent of this pipeline and never level-gated.
 */
import { queries, WS_EVENTS, createLogger } from "@alook/shared"
import type { Database, NotificationLevelValue } from "@alook/shared"
import { broadcastToUser } from "../broadcast"
import { enqueueBotWakes, type WakeMessageRow } from "./wake-producer"

const log = createLogger({ service: "community-notify" })

export interface MessageNotifyContext {
  /**
   * Snapshot author name for the `MENTION_CREATE` payload. The author is
   * already excluded from `recipients`/`mentionedUserIds` upstream — this is
   * only the label mentioned users see.
   */
  authorName: string
  /**
   * The lean row `findWakeCandidates` needs to enqueue channel bot-wakes.
   * Omitted for system/card messages (which must never wake bots) — when
   * absent, the wake leg is skipped entirely.
   */
  wakeMessageRow?: WakeMessageRow
}

/**
 * `true` when a recipient at `level` should be notified/woken for a message
 * where `wasMentioned` reflects whether THIS recipient was @-mentioned (or was
 * a reply target). Governs badge, wake, and the mention live push uniformly —
 * one predicate for the whole matrix.
 */
function shouldDeliver(level: NotificationLevelValue, wasMentioned: boolean): boolean {
  if (level === "all") return true
  if (level === "mentions") return wasMentioned
  return false // "nothing" — never
}

/**
 * Dispatch level-filtered notify signals for one just-created message.
 *
 * @param message  lean message row — `channelId` present ⇒ channel scope (mute
 *   applies); `channelId` null + `dmConversationId` set ⇒ DM scope, which is
 *   NOT in mute scope (no setting is keyed on a DM), so level filtering is
 *   bypassed and every mention delivers. Channel bot-wake + badge only run for
 *   the channel scope.
 * @param recipients  the fan-out recipient set (human + bot), already
 *   author-excluded — same list resolved for the `MESSAGE_CREATE` broadcast.
 * @param mentionedUserIds  users who would receive a `MENTION_CREATE`
 *   (explicit @ ∪ @everyone/@here ∪ reply targets) — already author-excluded.
 */
export async function dispatchMessageNotify(
  db: Database,
  ctx: MessageNotifyContext,
  message: WakeMessageRow,
  recipients: string[],
  opts: { mentionedUserIds: string[] },
): Promise<void> {
  try {
    const channelId = message.channelId ?? undefined
    const mentioned = new Set(opts.mentionedUserIds)

    // ── Resolve effective level for everyone we might touch ──────────────────
    // Channel scope: real per-recipient levels. DM scope (no channelId): mute
    // isn't in scope, so treat everyone as "all" (bypass) — R15/O4.
    const everyone = [...new Set([...recipients, ...opts.mentionedUserIds])]
    const levels: Map<string, NotificationLevelValue> = channelId
      ? await queries.communityNotificationSetting.resolveEffectiveLevelForUsers(db, everyone, channelId)
      : new Map(everyone.map((id) => [id, "all" as NotificationLevelValue]))

    const levelOf = (userId: string): NotificationLevelValue => levels.get(userId) ?? "all"

    // ── MENTION_CREATE live push (humans + bots alike) ───────────────────────
    // A mentioned user at level `nothing` gets NO live push — but their mention
    // ROW is still written by the caller (offline/inbox can surface it). DM
    // mentions (no channelId) always push: not in mute scope.
    for (const userId of mentioned) {
      if (!shouldDeliver(levelOf(userId), true)) continue
      broadcastToUser(userId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId,
        messageId: message.id,
        ...(channelId ? { channelId } : {}),
        authorName: ctx.authorName,
      }).catch(() => {})
    }

    // The channel scope owns the badge + wake legs. DM wake stays on
    // `fanOutToDM`'s direct `maybeEnqueueWakes` (R15) — never routed here.
    if (!channelId) return

    // ── Per-user UNREAD_BUMP badge signal (R23) ──────────────────────────────
    // NOT a boolean on the shared `MESSAGE_CREATE` payload — badge is
    // per-recipient (user A muted, user B not), so it rides a per-user event
    // like MENTION_CREATE. Only recipients whose level allows delivery get it;
    // the client's `message.create` handler no longer patches the badge itself
    // (R1 — it only appends content).
    for (const userId of recipients) {
      if (!shouldDeliver(levelOf(userId), mentioned.has(userId))) continue
      broadcastToUser(userId, {
        type: WS_EVENTS.UNREAD_BUMP,
        userId,
        channelId,
      }).catch(() => {})
    }

    // ── Bot wake (additive over findWakeCandidates' existing gates) ──────────
    // Pre-filter the recipient set to the delivering subset, then hand off to
    // `enqueueBotWakes` UNCHANGED — it still applies its own bot-filter +
    // findWakeCandidates' three gates (liveness / machine-binding / catch-up) +
    // the consumer's `already_read` gate. Level filtering is ADDITIVE, never a
    // replacement. Bots follow their own effective level exactly like humans.
    if (!ctx.wakeMessageRow) return
    const wakeRecipients = recipients.filter((userId) =>
      shouldDeliver(levelOf(userId), mentioned.has(userId)),
    )
    if (wakeRecipients.length === 0) return
    enqueueBotWakes({
      recipients: wakeRecipients,
      channelId,
      messageRow: ctx.wakeMessageRow,
    }).catch((err) => {
      log.warn("dispatch_notify_wake_failed", { err: String(err) })
    })
  } catch (err) {
    // Absorb all failures — the message already synced via MESSAGE_CREATE
    // (R1); a level-resolution blip must not fail the send.
    log.warn("dispatch_message_notify_failed", {
      messageId: message.id,
      err: String(err),
    })
  }
}

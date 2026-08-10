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
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, WS_EVENTS, createLogger } from "@alook/shared"
import type { Database, NotificationLevelValue, WsMessage } from "@alook/shared"
import { broadcastToUser } from "../broadcast"

const log = createLogger({ service: "community-notify" })
const notifyMaxActive = 3

type NotifyLeafTask = {
  kind: "mention" | "unread"
  userId: string
  event: WsMessage
}

type BoundedSettleResult = {
  results: PromiseSettledResult<void>[]
  maxActive: number
}

export async function settleNotifyTasks<T>(
  tasks: readonly T[],
  run: (task: T, index: number) => Promise<void>,
): Promise<BoundedSettleResult> {
  const results = new Array<PromiseSettledResult<void>>(tasks.length)
  let nextIndex = 0
  let active = 0
  let maxActive = 0

  const workers = Array.from(
    { length: Math.min(notifyMaxActive, tasks.length) },
    async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex
        nextIndex += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await run(tasks[index], index)
          results[index] = { status: "fulfilled", value: undefined }
        } catch (reason) {
          results[index] = { status: "rejected", reason }
        } finally {
          active -= 1
        }
      }
    },
  )

  await Promise.all(workers)
  return { results, maxActive }
}

function safeLog(write: () => void): void {
  try {
    write()
  } catch {}
}

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
 * @param channelId  the message's channel scope. Every scope (channel, child
 *   thread, AND dm) resolves its per-recipient level here — there is NO
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
async function runMessageNotify(
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
    /** Sidebar-locatable row = `parentChannelId ?? channelId` (child-thread
     * light the parent row). From the caller's target, no extra query. */
    railChannelId?: string
  },
): Promise<void> {
  const startedAt = Date.now()
  try {
    const { channelId } = message
    const recipientIds = [...new Set(recipients)]
    const mentionedIds = [...new Set(opts.mentionedUserIds)]
    const mentioned = new Set(mentionedIds)

    const everyone = [...new Set([...recipientIds, ...mentionedIds])]
    const levels = await queries.communityNotificationSetting.resolveEffectiveLevelForUsers(
      db,
      everyone,
      channelId,
    )
    const levelOf = (userId: string): NotificationLevelValue => levels.get(userId) ?? "all"
    const tasks: NotifyLeafTask[] = []

    for (const userId of mentionedIds) {
      if (!shouldDeliver(levelOf(userId), true)) continue
      tasks.push({
        kind: "mention",
        userId,
        event: {
          type: WS_EVENTS.MENTION_CREATE,
          userId,
          messageId: message.id,
          channelId,
          authorName: ctx.authorName,
        },
      })
    }

    for (const userId of recipientIds) {
      const isMention = mentioned.has(userId)
      if (!shouldDeliver(levelOf(userId), isMention)) continue
      tasks.push({
        kind: "unread",
        userId,
        event: {
          type: WS_EVENTS.UNREAD_BUMP,
          userId,
          channelId,
          ...(opts.serverId !== undefined ? { serverId: opts.serverId } : {}),
          ...(opts.railChannelId !== undefined ? { railChannelId: opts.railChannelId } : {}),
          isMention,
        },
      })
    }

    const { results, maxActive } = await settleNotifyTasks(
      tasks,
      (task) => broadcastToUser(task.userId, task.event),
    )
    let mentionSuccess = 0
    let mentionFailure = 0
    let unreadSuccess = 0
    let unreadFailure = 0

    for (const [index, result] of results.entries()) {
      const succeeded = result.status === "fulfilled"
      if (tasks[index].kind === "mention") {
        if (succeeded) mentionSuccess += 1
        else mentionFailure += 1
      } else if (succeeded) {
        unreadSuccess += 1
      } else {
        unreadFailure += 1
      }
    }

    safeLog(() => log.info("dispatch_message_notify_complete", {
      messageId: message.id,
      recipientCount: recipientIds.length,
      mentionedCount: mentionedIds.length,
      leafTaskCount: tasks.length,
      mentionSuccess,
      mentionFailure,
      unreadSuccess,
      unreadFailure,
      maxActive,
      durationMs: Date.now() - startedAt,
    }))
  } catch (err) {
    safeLog(() => log.warn("dispatch_message_notify_failed", {
      messageId: message.id,
      err: String(err),
      durationMs: Date.now() - startedAt,
    }))
  }
}

export function dispatchMessageNotify(
  db: Database,
  ctx: MessageNotifyContext,
  message: { id: string; channelId: string },
  recipients: string[],
  opts: {
    mentionedUserIds: string[]
    serverId?: string
    railChannelId?: string
  },
): Promise<void> {
  const work = runMessageNotify(db, ctx, message, recipients, opts)
  try {
    const cloudflareContext = getCloudflareContext()
    cloudflareContext.ctx.waitUntil(work)
  } catch {}
  return work
}

import type { Database } from "@alook/shared";
import { queries, TASK_TYPES } from "@alook/shared";
import { log } from "@/lib/logger";

const {
  listDueCalendarEvents,
  claimCalendarEvent,
  revertCalendarEventClaim,
  updateCalendarEventSchedule,
  computeNextScheduledAt,
} = queries.calendarEvent;

/**
 * Convert a user-provided local calendar date (YYYY-MM-DD) into an inclusive
 * UTC end-of-day ISO string in the caller's local timezone. Used to store the
 * repeat stop boundary.
 */
export function repeatStopDateToStopAt(repeatStopDate: string): string {
  const [y, m, d] = repeatStopDate.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`invalid repeat_stop_date: ${repeatStopDate}`);
  }
  const date = new Date(y, m - 1, d, 23, 59, 59, 999);
  return date.toISOString();
}

/**
 * Promote due calendar events in the given workspace into queued tasks.
 *
 * The only concurrency primitive is the exact-occurrence guarded UPDATE in
 * `claimCalendarEvent` — every step after claim is best-effort, with a
 * compensating revert on failure. Runtime/owner pre-checks are done before the
 * claim so a non-runnable event stays eligible for a later poll.
 *
 * Returns the number of events enqueued as tasks.
 */
export async function promoteDueCalendarEventsForWorkspace(
  db: Database,
  workspaceId: string,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const candidates = await listDueCalendarEvents(db, workspaceId, nowIso);
  let enqueued = 0;

  for (const ev of candidates) {
    // Pre-claim checks — skip without writing so the event remains eligible
    // for a later poll once the agent has a runtime/owner.
    const agent = await queries.agent.getAgent(db, ev.agentId, ev.workspaceId);
    if (!agent) {
      log.warn("calendar: agent missing, skipping", { id: ev.id });
      continue;
    }
    if (!agent.runtimeId) {
      log.warn("calendar: agent has no runtime, skipping", { id: ev.id });
      continue;
    }
    if (!agent.ownerId) {
      log.warn("calendar: agent has no owner, skipping", { id: ev.id });
      continue;
    }

    const previousLastTriggeredAt = ev.lastTriggeredAt ?? null;
    const claimed = await claimCalendarEvent(db, ev.id, ev.scheduledAt, nowIso);
    if (!claimed) {
      // Another caller won the guarded UPDATE; skip.
      continue;
    }

    try {
      const conv = await queries.conversation.createConversation(db, {
        workspaceId: ev.workspaceId,
        agentId: ev.agentId,
        userId: agent.ownerId,
        title: `[Calendar] ${ev.title}`.slice(0, 120),
        type: TASK_TYPES.CALENDAR_EVENT,
      });

      await queries.message.createMessage(db, {
        conversationId: conv.id,
        role: "event",
        content: ev.title,
      });

      await queries.task.createTask(db, {
        agentId: ev.agentId,
        runtimeId: agent.runtimeId,
        workspaceId: ev.workspaceId,
        conversationId: conv.id,
        prompt: ev.title,
        type: TASK_TYPES.CALENDAR_EVENT,
        priority: 0,
      });

      if (ev.repeatInterval) {
        const next = computeNextScheduledAt(
          ev.scheduledAt,
          ev.repeatInterval,
          ev.repeatStopAt ?? null,
          nowIso,
          ev.exceptions ?? [],
        );
        if (next) {
          await updateCalendarEventSchedule(db, ev.id, next);
        }
      }

      enqueued++;
    } catch (err) {
      log.warn("calendar: post-claim write failed, reverting", {
        id: ev.id,
        err: String(err),
      });
      // Compensating revert — event becomes eligible again on the next poll.
      try {
        await revertCalendarEventClaim(db, ev.id, previousLastTriggeredAt);
      } catch (revertErr) {
        log.error("calendar: compensating revert failed", {
          id: ev.id,
          err: String(revertErr),
        });
      }
    }
  }

  if (enqueued > 0) {
    log.info("calendar: promoted due events", { workspaceId, enqueued });
  }
  return enqueued;
}

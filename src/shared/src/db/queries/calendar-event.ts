import { eq, and, asc, gte, lte, or, isNull, isNotNull, lt } from "drizzle-orm";
import { agent, calendarEvent } from "../schema";
import type { Database } from "../index";

export async function createCalendarEvent(
  db: Database,
  data: {
    agentId: string;
    workspaceId: string;
    title: string;
    description?: string | null;
    scheduledAt: string;
    repeatInterval?: string | null;
    repeatStopAt?: string | null;
    exceptions?: string[];
  }
) {
  const now = new Date().toISOString();
  const rows = await db
    .insert(calendarEvent)
    .values({
      agentId: data.agentId,
      workspaceId: data.workspaceId,
      title: data.title,
      description: data.description ?? null,
      scheduledAt: data.scheduledAt,
      repeatInterval: data.repeatInterval ?? null,
      repeatStopAt: data.repeatStopAt ?? null,
      exceptions: data.exceptions ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0]!;
}

export async function updateCalendarEvent(
  db: Database,
  id: string,
  workspaceId: string,
  patch: {
    title?: string;
    description?: string | null;
    agentId?: string;
    scheduledAt?: string;
    repeatInterval?: string | null;
    repeatStopAt?: string | null;
    exceptions?: string[];
  }
) {
  const rows = await db
    .update(calendarEvent)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      and(eq(calendarEvent.id, id), eq(calendarEvent.workspaceId, workspaceId))
    )
    .returning();
  return rows[0] ?? null;
}

export async function getCalendarEvent(
  db: Database,
  id: string,
  workspaceId: string,
  userId?: string
) {
  const conditions = [eq(calendarEvent.id, id), eq(calendarEvent.workspaceId, workspaceId)];
  if (userId) {
    conditions.push(eq(agent.ownerId, userId));
    const rows = await db
      .select({ calendarEvent })
      .from(calendarEvent)
      .innerJoin(agent, eq(calendarEvent.agentId, agent.id))
      .where(and(...conditions));
    return rows[0]?.calendarEvent ?? null;
  }
  const rows = await db
    .select()
    .from(calendarEvent)
    .where(and(...conditions));
  return rows[0] ?? null;
}

export async function listCalendarEvents(
  db: Database,
  workspaceId: string,
  opts: { userId?: string; agentId?: string; from?: string; to?: string } = {}
) {
  const conditions = [eq(calendarEvent.workspaceId, workspaceId)];
  if (opts.agentId) conditions.push(eq(calendarEvent.agentId, opts.agentId));
  if (opts.userId) conditions.push(eq(agent.ownerId, opts.userId));

  // Exclude completed one-off events: non-recurring events where
  // lastTriggeredAt is set and >= scheduledAt are "done".
  conditions.push(
    or(
      isNotNull(calendarEvent.repeatInterval),
      isNull(calendarEvent.lastTriggeredAt),
      lt(calendarEvent.lastTriggeredAt, calendarEvent.scheduledAt)
    )!
  );

  if (opts.from && opts.to) {
    // Non-recurring rows are bounded strictly by [from, to] on scheduled_at.
    // Recurring rows may have scheduled_at before `from` (next fire is
    // earlier) but still produce visible occurrences inside the window; they
    // qualify when (a) scheduled_at <= to, and (b) repeat_stop_at is null
    // or >= from. Expansion happens in the caller.
    conditions.push(
      or(
        and(
          isNull(calendarEvent.repeatInterval),
          gte(calendarEvent.scheduledAt, opts.from),
          lte(calendarEvent.scheduledAt, opts.to)
        ),
        and(
          isNotNull(calendarEvent.repeatInterval),
          lte(calendarEvent.scheduledAt, opts.to),
          or(
            isNull(calendarEvent.repeatStopAt),
            gte(calendarEvent.repeatStopAt, opts.from)
          )
        )
      )!
    );
  } else {
    if (opts.from) conditions.push(gte(calendarEvent.scheduledAt, opts.from));
    if (opts.to) conditions.push(lte(calendarEvent.scheduledAt, opts.to));
  }

  if (opts.userId) {
    const rows = await db
      .select({ calendarEvent })
      .from(calendarEvent)
      .innerJoin(agent, eq(calendarEvent.agentId, agent.id))
      .where(and(...conditions))
      .orderBy(asc(calendarEvent.scheduledAt));
    return rows.map(r => r.calendarEvent);
  }
  return db
    .select()
    .from(calendarEvent)
    .where(and(...conditions))
    .orderBy(asc(calendarEvent.scheduledAt));
}

export async function deleteCalendarEvent(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .delete(calendarEvent)
    .where(
      and(eq(calendarEvent.id, id), eq(calendarEvent.workspaceId, workspaceId))
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Return candidate due events for a workspace. Does not write — callers must
 * issue the guarded claim UPDATE to promote an event to a task.
 */
export async function listDueCalendarEvents(
  db: Database,
  workspaceId: string,
  now: string
) {
  return db
    .select()
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.workspaceId, workspaceId),
        lte(calendarEvent.scheduledAt, now),
        or(
          isNull(calendarEvent.lastTriggeredAt),
          lt(calendarEvent.lastTriggeredAt, calendarEvent.scheduledAt)
        )
      )
    )
    .orderBy(asc(calendarEvent.scheduledAt));
}

/**
 * Exact-occurrence guarded claim. Returns the number of rows affected (0 or 1).
 * Only one concurrent caller can transition `last_triggered_at` past the
 * observed `scheduled_at`; every other caller sees 0.
 */
export async function claimCalendarEvent(
  db: Database,
  id: string,
  observedScheduledAt: string,
  now: string
) {
  const rows = await db
    .update(calendarEvent)
    .set({ lastTriggeredAt: now, updatedAt: now })
    .where(
      and(
        eq(calendarEvent.id, id),
        eq(calendarEvent.scheduledAt, observedScheduledAt),
        or(
          isNull(calendarEvent.lastTriggeredAt),
          lt(calendarEvent.lastTriggeredAt, calendarEvent.scheduledAt)
        )
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Revert `last_triggered_at` to its pre-claim value after a post-claim failure. */
export async function revertCalendarEventClaim(
  db: Database,
  id: string,
  previousLastTriggeredAt: string | null
) {
  await db
    .update(calendarEvent)
    .set({
      lastTriggeredAt: previousLastTriggeredAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(calendarEvent.id, id));
}

/**
 * Advance `scheduled_at` to the next future occurrence, or null when the event
 * has stopped. Used by the promotion helper after a successful claim.
 */
export async function updateCalendarEventSchedule(
  db: Database,
  id: string,
  nextScheduledAt: string
) {
  await db
    .update(calendarEvent)
    .set({ scheduledAt: nextScheduledAt, updatedAt: new Date().toISOString() })
    .where(eq(calendarEvent.id, id));
}

/**
 * Repeat-interval grammar: `<positive_integer><min|hour|day|week|month>`.
 *
 * Monthly overflow clamp: Jan 31 + 1 month = Feb 28 (or 29 in leap years).
 * Week is treated as 7 days.
 */
export function addRepeatInterval(base: Date, interval: string): Date {
  const match = /^(\d+)(min|hour|day|week|month)$/.exec(interval);
  if (!match) throw new Error(`invalid repeat_interval: ${interval}`);
  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (unit === "min") return new Date(base.getTime() + amount * 60_000);
  if (unit === "hour") return new Date(base.getTime() + amount * 3_600_000);
  if (unit === "day") return new Date(base.getTime() + amount * 86_400_000);
  if (unit === "week") return new Date(base.getTime() + amount * 7 * 86_400_000);
  // month — clamp overflow
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + amount;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const day = base.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
}

/**
 * Loop-advance the schedule past `now`. Returns the next `scheduled_at` as an
 * ISO string, or null if the next occurrence would exceed `repeatStopAt` (in
 * which case the event becomes inert).
 */
/**
 * Expand a recurring calendar-event row into the list of occurrence ISOs
 * within `[from, to]`, skipping `exceptions`. Starts at `scheduledAt` and
 * steps forward by `repeatInterval`. Capped at 1000 iterations to guard
 * against pathological inputs.
 */
export function expandOccurrences(
  scheduledAt: string,
  repeatInterval: string,
  repeatStopAt: string | null,
  exceptions: string[],
  from: string,
  to: string
): string[] {
  const out: string[] = [];
  const fromD = new Date(from);
  const toD = new Date(to);
  const stopD = repeatStopAt ? new Date(repeatStopAt) : null;
  const excepted = new Set(exceptions);
  let current = new Date(scheduledAt);
  for (let i = 0; i < 1000; i++) {
    if (current > toD) break;
    if (stopD && current > stopD) break;
    const iso = current.toISOString();
    if (current >= fromD && !excepted.has(iso)) out.push(iso);
    current = addRepeatInterval(current, repeatInterval);
  }
  return out;
}

/**
 * Returns how many times a recurring event fires per day.
 * Used to decide whether to collapse high-frequency events (threshold: >5/day).
 */
export function getOccurrencesPerDay(repeatInterval: string): number {
  const match = /^(\d+)(min|hour|day|week|month)$/.exec(repeatInterval);
  if (!match) return 1;
  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (unit === "month" || unit === "week" || unit === "day") return 1;
  if (amount === 0) return 1;
  const intervalSeconds = unit === "min" ? amount * 60 : amount * 3600;
  return Math.floor(86400 / intervalSeconds);
}

export function computeNextScheduledAt(
  currentScheduledAt: string,
  repeatInterval: string,
  repeatStopAt: string | null,
  now: string,
  exceptions: string[] = []
): string | null {
  const excepted = new Set(exceptions);
  let next = addRepeatInterval(new Date(currentScheduledAt), repeatInterval);
  const nowDate = new Date(now);
  const stopDate = repeatStopAt ? new Date(repeatStopAt) : null;
  // Cap iterations to prevent runaway loops on pathological inputs.
  for (let i = 0; i < 2000; i++) {
    if (stopDate && next > stopDate) return null;
    if (next > nowDate && !excepted.has(next.toISOString())) {
      return next.toISOString();
    }
    next = addRepeatInterval(next, repeatInterval);
  }
  return null;
}

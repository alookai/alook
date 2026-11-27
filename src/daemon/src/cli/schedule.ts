import type { Command } from "commander";
import {
  isValidIanaTimeZone,
  ScheduleCreateRequestSchema,
  ScheduleRecurrenceFreqSchema,
  ScheduleUpdateRequestSchema,
  type ScheduleEvent,
  type ScheduleOccurrence,
  type ScheduleRecurrence,
} from "@alook/shared";
import type { ServerApi } from "../server/contract.js";
import { toLocalISO } from "../util/localTime.js";

const WEEKDAY_TOKENS: Record<string, number> = {
  "0": 0, sun: 0, sunday: 0,
  "1": 1, mon: 1, monday: 1,
  "2": 2, tue: 2, tues: 2, tuesday: 2,
  "3": 3, wed: 3, wednesday: 3,
  "4": 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  "5": 5, fri: 5, friday: 5,
  "6": 6, sat: 6, saturday: 6,
};

function parseIsoOption(raw: string, flag: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${flag} must be a valid ISO-8601 timestamp (e.g. 2026-11-26T09:00:00+08:00)`);
  }
  return new Date(ms).toISOString();
}

function parsePositiveIntOption(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${flag} must be a positive integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parseWeekdaysOption(raw: string): number[] {
  const tokens = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) throw new Error("--weekdays requires at least one weekday (0-6 or sun..sat)");
  const days: number[] = [];
  for (const token of tokens) {
    const mapped = WEEKDAY_TOKENS[token];
    if (mapped === undefined) throw new Error(`invalid weekday "${token}" (use 0-6 or sun..sat)`);
    days.push(mapped);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function parseRecurrenceOptions(opts: {
  repeat?: string;
  interval?: string;
  weekdays?: string;
  until?: string;
  count?: string;
}): ScheduleRecurrence | null | undefined {
  const hasRecurrenceFlags =
    opts.repeat !== undefined
    || opts.interval !== undefined
    || opts.weekdays !== undefined
    || opts.until !== undefined
    || opts.count !== undefined;

  if (!hasRecurrenceFlags) return undefined;
  if (opts.repeat?.trim().toLowerCase() === "none") return null;
  if (!opts.repeat) {
    throw new Error("--repeat <hourly|daily|weekly|monthly> is required when using --interval, --weekdays, --until, or --count");
  }

  const freq = ScheduleRecurrenceFreqSchema.safeParse(opts.repeat.trim().toLowerCase());
  if (!freq.success) {
    throw new Error("--repeat must be one of hourly, daily, weekly, monthly, or none");
  }
  const interval = opts.interval ? parsePositiveIntOption(opts.interval, "--interval") : 1;
  const byWeekday = opts.weekdays ? parseWeekdaysOption(opts.weekdays) : undefined;
  const untilAt = opts.until && opts.until.trim().toLowerCase() !== "none"
    ? parseIsoOption(opts.until, "--until")
    : undefined;
  const count = opts.count && opts.count.trim().toLowerCase() !== "none"
    ? parsePositiveIntOption(opts.count, "--count")
    : undefined;

  return {
    freq: freq.data,
    interval,
    ...(byWeekday ? { byWeekday } : {}),
    ...(untilAt ? { untilAt } : {}),
    ...(count ? { count } : {}),
  };
}

function defaultLocalTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidIanaTimeZone(tz) ? tz : "UTC";
}

/**
 * Strip internal database IDs before presenting schedule state to an agent;
 * bots address events by public `sch_*` id, creators by `@handle`, and bound
 * messages by channel ref.
 */
function presentScheduleEventForAgent(event: ScheduleEvent) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    createdBy: event.createdBy.handle,
    startAt: toLocalISO(event.startAt),
    durationMinutes: event.durationMinutes,
    timeZone: event.timeZone,
    recurrence: event.recurrence
      ? {
          ...event.recurrence,
          ...(event.recurrence.untilAt ? { untilAt: toLocalISO(event.recurrence.untilAt) } : {}),
        }
      : null,
    nextRunAt: event.nextRunAt ? toLocalISO(event.nextRunAt) : null,
    sourceMessage: {
      accessible: event.sourceMessage.accessible,
      status: event.sourceMessage.status,
      ...(event.sourceMessage.ref ? { ref: event.sourceMessage.ref } : {}),
      ...(event.sourceMessage.preview ? { preview: event.sourceMessage.preview } : {}),
    },
    ...(event.lastExecution
      ? {
          lastExecution: {
            scheduledAt: toLocalISO(event.lastExecution.scheduledAt),
            status: event.lastExecution.status,
            ...(event.lastExecution.ackedAt ? { ackedAt: toLocalISO(event.lastExecution.ackedAt) } : {}),
            ...(event.lastExecution.lastError ? { lastError: event.lastExecution.lastError } : {}),
            updatedAt: toLocalISO(event.lastExecution.updatedAt),
          },
        }
      : {}),
    createdAt: toLocalISO(event.createdAt),
    updatedAt: toLocalISO(event.updatedAt),
  };
}

function presentOccurrenceForAgent(occ: ScheduleOccurrence) {
  return {
    eventId: occ.eventId,
    startAt: toLocalISO(occ.startAt),
    endAt: toLocalISO(occ.endAt),
    runStatus: occ.runStatus,
  };
}

export function registerScheduleCommands(
  program: Command,
  getApi: () => ServerApi,
  output: (value: { success: unknown }) => void,
): void {
  const schedule = program
    .command("schedule")
    .description("manage the household shared schedule (owner and bots)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });

  schedule
    .command("list")
    .description("list shared schedule events and optional expanded occurrences")
    .option("--from <iso>", "window start (ISO-8601, pair with --to)")
    .option("--to <iso>", "window end (ISO-8601, pair with --from)")
    .option("--creator <handle>", "filter by creator handle (e.g. @Elwira#8700)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const opts = this.opts() as {
        from?: string;
        to?: string;
        creator?: string;
      };
      const api = getApi();
      if (!api.scheduleList) throw new Error("Schedule commands are unavailable");
      const from = opts.from ? parseIsoOption(opts.from, "--from") : undefined;
      const to = opts.to ? parseIsoOption(opts.to, "--to") : undefined;
      const res = await api.scheduleList({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(opts.creator ? { creatorHandle: opts.creator } : {}),
      });
      output({
        success: {
          events: res.events.map(presentScheduleEventForAgent),
          ...(res.occurrences.length > 0 ? { occurrences: res.occurrences.map(presentOccurrenceForAgent) } : {}),
          creators: res.creators.map((c) => c.handle),
        },
      });
    });

  schedule
    .command("create")
    .description("create a shared schedule event bound to a concrete message")
    .requiredOption("--title <text>", "event title (1-160 chars)")
    .requiredOption("--at <iso>", "first scheduled trigger time (ISO-8601)")
    .requiredOption("--message <ref>", "full message ref bound for reply context (e.g. /Server#1234/chan#42)")
    .option("--description <text>", "instructions/context for the scheduled execution")
    .option("--tz <iana>", "IANA timezone (defaults to local machine timezone)")
    .option("--duration <minutes>", "event duration in minutes (5-1440, default 30)")
    .option("--repeat <freq>", "recurrence frequency: hourly, daily, weekly, monthly")
    .option("--interval <n>", "recurrence interval (default 1)")
    .option("--weekdays <days>", "comma-separated weekdays for weekly repeat (0-6 or sun..sat)")
    .option("--until <iso>", "recurrence end timestamp (ISO-8601)")
    .option("--count <n>", "maximum total occurrences (1-1000)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command) {
      const opts = this.opts() as {
        title: string;
        at: string;
        message: string;
        description?: string;
        tz?: string;
        duration?: string;
        repeat?: string;
        interval?: string;
        weekdays?: string;
        until?: string;
        count?: string;
      };
      const api = getApi();
      if (!api.scheduleCreate) throw new Error("Schedule commands are unavailable");
      const timeZone = opts.tz?.trim() || defaultLocalTimeZone();
      if (!isValidIanaTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
      const recurrence = parseRecurrenceOptions(opts);
      const payload = ScheduleCreateRequestSchema.parse({
        title: opts.title,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        startAt: parseIsoOption(opts.at, "--at"),
        ...(opts.duration !== undefined ? { durationMinutes: parsePositiveIntOption(opts.duration, "--duration") } : {}),
        timeZone,
        ...(recurrence !== undefined ? { recurrence } : {}),
        sourceMessageRef: opts.message,
      });
      const res = await api.scheduleCreate(payload);
      output({ success: { event: presentScheduleEventForAgent(res.event) } });
    });

  schedule
    .command("update")
    .argument("<id>", "schedule event id (sch_...)")
    .description("update a shared schedule event")
    .option("--title <text>", "new title")
    .option("--description <text>", "new instructions/context")
    .option("--at <iso>", "new start time (ISO-8601)")
    .option("--tz <iana>", "new IANA timezone")
    .option("--duration <minutes>", "new duration in minutes (5-1440)")
    .option("--repeat <freq>", "hourly, daily, weekly, monthly, or none to clear recurrence")
    .option("--interval <n>", "recurrence interval")
    .option("--weekdays <days>", "comma-separated weekdays for weekly repeat (0-6 or sun..sat)")
    .option("--until <iso>", "recurrence end timestamp (ISO-8601)")
    .option("--count <n>", "maximum total occurrences")
    .option("--message <ref>", "rebind to another accessible message ref")
    .option("--ack", "mark the current scheduled execution as completed")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async function (this: Command, id: string) {
      const opts = this.opts() as {
        title?: string;
        description?: string;
        at?: string;
        tz?: string;
        duration?: string;
        repeat?: string;
        interval?: string;
        weekdays?: string;
        until?: string;
        count?: string;
        message?: string;
        ack?: boolean;
      };
      const api = getApi();
      if (!api.scheduleUpdate) throw new Error("Schedule commands are unavailable");
      if (opts.tz !== undefined && !isValidIanaTimeZone(opts.tz.trim())) {
        throw new Error(`invalid IANA timezone: ${opts.tz}`);
      }
      const recurrence = parseRecurrenceOptions(opts);
      const patch = ScheduleUpdateRequestSchema.parse({
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.at !== undefined ? { startAt: parseIsoOption(opts.at, "--at") } : {}),
        ...(opts.tz !== undefined ? { timeZone: opts.tz.trim() } : {}),
        ...(opts.duration !== undefined ? { durationMinutes: parsePositiveIntOption(opts.duration, "--duration") } : {}),
        ...(recurrence !== undefined ? { recurrence } : {}),
        ...(opts.message !== undefined ? { sourceMessageRef: opts.message } : {}),
        ...(opts.ack ? { ack: true as const } : {}),
      });
      if (Object.keys(patch).length === 0) {
        throw new Error("provide at least one field to update");
      }
      const res = await api.scheduleUpdate({ id, patch });
      output({ success: { event: presentScheduleEventForAgent(res.event) } });
    });

  schedule
    .command("delete")
    .argument("<id>", "schedule event id (sch_...)")
    .description("delete a shared schedule event")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .action(async (id: string) => {
      const api = getApi();
      if (!api.scheduleDelete) throw new Error("Schedule commands are unavailable");
      await api.scheduleDelete({ id });
      output({ success: { deleted: true, id } });
    });
}

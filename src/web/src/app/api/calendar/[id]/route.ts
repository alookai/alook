import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  UpdateCalendarEventRequestSchema,
  DeleteCalendarEventRequestSchema,
  computeNextScheduledAt,
  isEmptyHtml,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { calendarEventToResponse } from "@/lib/api/responses";
import { repeatStopDateToStopAt } from "@/lib/services/calendar";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("calendar event id is required", 400);

  const event = await queries.calendarEvent.getCalendarEvent(
    db,
    id,
    ws.workspaceId,
    ctx.userId
  );
  if (!event) return writeError("calendar event not found", 404);
  return writeJSON(calendarEventToResponse(event));
});

export const PATCH = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("calendar event id is required", 400);

  const [body, err] = await parseBody(req, UpdateCalendarEventRequestSchema);
  if (err) return err;

  const source = await queries.calendarEvent.getCalendarEvent(
    db,
    id,
    ws.workspaceId,
    ctx.userId
  );
  if (!source) return writeError("calendar event not found", 404);

  if (body.agent_id !== undefined) {
    const agent = await queries.agent.getAgent(
      db,
      body.agent_id,
      ws.workspaceId,
      ctx.userId
    );
    if (!agent) return writeError("agent not found in workspace", 404);
  }

  const patch: {
    title?: string;
    description?: string | null;
    agentId?: string;
    scheduledAt?: string;
    repeatInterval?: string | null;
    repeatStopAt?: string | null;
  } = {};

  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) {
    const rawDesc = body.description?.trim() || null;
    patch.description = rawDesc && isEmptyHtml(rawDesc) ? null : rawDesc;
  }
  if (body.agent_id !== undefined) patch.agentId = body.agent_id;
  if (body.scheduled_at !== undefined) {
    patch.scheduledAt = new Date(body.scheduled_at).toISOString();
  }
  if (body.repeat_interval !== undefined) {
    patch.repeatInterval = body.repeat_interval;
  }
  if (body.repeat_stop_date !== undefined) {
    patch.repeatStopAt =
      body.repeat_stop_date === null
        ? null
        : repeatStopDateToStopAt(body.repeat_stop_date);
  }

  const wantSplit =
    body.scope === "this" &&
    source.repeatInterval !== null &&
    source.repeatInterval !== undefined;

  if (!wantSplit) {
    const updated = await queries.calendarEvent.updateCalendarEvent(
      db,
      id,
      ws.workspaceId,
      patch
    );
    if (!updated) return writeError("calendar event not found", 404);
    return writeJSON(calendarEventToResponse(updated));
  }

  // Split path: detach a specific occurrence. Anchor on occurrence_at
  // (default = source.scheduledAt — the next fire).
  const occurrenceAt = body.occurrence_at
    ? new Date(body.occurrence_at).toISOString()
    : source.scheduledAt;
  const existingExceptions = source.exceptions ?? [];

  if (occurrenceAt === source.scheduledAt) {
    // Editing the next fire — advance the parent past this occurrence.
    const next = computeNextScheduledAt(
      source.scheduledAt,
      source.repeatInterval!,
      source.repeatStopAt ?? null,
      source.scheduledAt,
      existingExceptions
    );
    if (next === null) {
      await queries.calendarEvent.deleteCalendarEvent(db, id, ws.workspaceId);
    } else {
      const advanced = await queries.calendarEvent.updateCalendarEvent(
        db,
        id,
        ws.workspaceId,
        { scheduledAt: next }
      );
      if (!advanced) return writeError("calendar event not found", 404);
    }
  } else {
    // Editing a future occurrence — record it as an exception on the parent.
    const nextExceptions = existingExceptions.includes(occurrenceAt)
      ? existingExceptions
      : [...existingExceptions, occurrenceAt];
    const updated = await queries.calendarEvent.updateCalendarEvent(
      db,
      id,
      ws.workspaceId,
      { exceptions: nextExceptions }
    );
    if (!updated) return writeError("calendar event not found", 404);
  }

  const detached = await queries.calendarEvent.createCalendarEvent(db, {
    agentId: patch.agentId ?? source.agentId,
    workspaceId: ws.workspaceId,
    title: patch.title ?? source.title,
    description:
      patch.description !== undefined ? patch.description : source.description ?? null,
    scheduledAt: patch.scheduledAt ?? occurrenceAt,
    repeatInterval: null,
    repeatStopAt: null,
    exceptions: [],
  });

  return writeJSON(calendarEventToResponse(detached));
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("calendar event id is required", 400);

  // Body is optional: an empty payload keeps legacy "delete the whole row"
  // behavior. Only validate when the caller actually sent one.
  let body: { scope?: "this" | "following"; occurrence_at?: string } = {};
  const rawText = await req.text();
  if (rawText.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch {
      return writeError("invalid request body", 400);
    }
    const parsed = DeleteCalendarEventRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return writeError("validation error", 400);
    }
    body = parsed.data;
  }

  const source = await queries.calendarEvent.getCalendarEvent(
    db,
    id,
    ws.workspaceId,
    ctx.userId
  );
  if (!source) return writeError("calendar event not found", 404);

  const isRecurring = Boolean(source.repeatInterval);
  const scope = body.scope;

  // Non-recurring, or no scope given → full delete (covers legacy callers).
  if (!scope || !isRecurring) {
    const deleted = await queries.calendarEvent.deleteCalendarEvent(
      db,
      id,
      ws.workspaceId
    );
    if (!deleted) return writeError("calendar event not found", 404);
    return writeJSON(calendarEventToResponse(deleted));
  }

  const occurrenceAt = body.occurrence_at
    ? new Date(body.occurrence_at).toISOString()
    : source.scheduledAt;
  const existingExceptions = source.exceptions ?? [];

  if (scope === "this") {
    if (occurrenceAt === source.scheduledAt) {
      // Skip the next fire: advance parent to the following occurrence.
      const next = computeNextScheduledAt(
        source.scheduledAt,
        source.repeatInterval!,
        source.repeatStopAt ?? null,
        source.scheduledAt,
        existingExceptions
      );
      if (next === null) {
        const deleted = await queries.calendarEvent.deleteCalendarEvent(
          db,
          id,
          ws.workspaceId
        );
        if (!deleted) return writeError("calendar event not found", 404);
        return writeJSON(calendarEventToResponse(deleted));
      }
      const advanced = await queries.calendarEvent.updateCalendarEvent(
        db,
        id,
        ws.workspaceId,
        { scheduledAt: next }
      );
      if (!advanced) return writeError("calendar event not found", 404);
      return writeJSON(calendarEventToResponse(advanced));
    }
    // Skip a future occurrence: record it as an exception. No change to
    // scheduled_at — the parent keeps firing on its normal cadence.
    const nextExceptions = existingExceptions.includes(occurrenceAt)
      ? existingExceptions
      : [...existingExceptions, occurrenceAt];
    const updated = await queries.calendarEvent.updateCalendarEvent(
      db,
      id,
      ws.workspaceId,
      { exceptions: nextExceptions }
    );
    if (!updated) return writeError("calendar event not found", 404);
    return writeJSON(calendarEventToResponse(updated));
  }

  // scope === "following"
  // If the cut point is the next fire (or earlier), the series has no
  // remaining occurrences — just drop the row.
  if (new Date(occurrenceAt).getTime() <= new Date(source.scheduledAt).getTime()) {
    const deleted = await queries.calendarEvent.deleteCalendarEvent(
      db,
      id,
      ws.workspaceId
    );
    if (!deleted) return writeError("calendar event not found", 404);
    return writeJSON(calendarEventToResponse(deleted));
  }

  // Future cut point: clip the series one ms before the occurrence so
  // everything from `occurrenceAt` onward is pruned by expandOccurrences
  // (which breaks on `current > stopD`).
  const clippedStop = new Date(
    new Date(occurrenceAt).getTime() - 1
  ).toISOString();
  const updated = await queries.calendarEvent.updateCalendarEvent(
    db,
    id,
    ws.workspaceId,
    { repeatStopAt: clippedStop }
  );
  if (!updated) return writeError("calendar event not found", 404);
  return writeJSON(calendarEventToResponse(updated));
});

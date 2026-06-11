import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  CreateCalendarEventRequestSchema,
  expandOccurrences,
  getOccurrencesPerDay,
  isEmptyHtml,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { calendarEventToResponse } from "@/lib/api/responses";
import { repeatStopDateToStopAt } from "@/lib/services/calendar";
import { broadcastToUser } from "@/lib/broadcast";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const to = req.nextUrl.searchParams.get("to") ?? undefined;

  const rows = await queries.calendarEvent.listCalendarEvents(
    db,
    ws.workspaceId,
    { userId: ctx.userId, agentId, from, to }
  );

  // Expand recurring rows into per-occurrence virtual rows within [from, to].
  // High-frequency events (>5 occurrences/day) are collapsed into one row per
  // UTC day with a `collapsed_count` hint instead of expanding individually.
  const out: (ReturnType<typeof calendarEventToResponse> & { _type?: string; _status?: string })[] = [];
  for (const row of rows) {
    if (!row.repeatInterval || !from || !to) {
      out.push(calendarEventToResponse(row));
      continue;
    }
    const perDay = getOccurrencesPerDay(row.repeatInterval);
    if (perDay > 5) {
      // Collapse: emit one representative row per UTC day in the range
      const fromD = new Date(from);
      const toD = new Date(to);
      const startD = new Date(row.scheduledAt);
      const stopD = row.repeatStopAt ? new Date(row.repeatStopAt) : null;

      // Iterate UTC days in [from, to], capped at 366 days
      const cursor = new Date(Date.UTC(fromD.getUTCFullYear(), fromD.getUTCMonth(), fromD.getUTCDate()));
      const endDay = new Date(Date.UTC(toD.getUTCFullYear(), toD.getUTCMonth(), toD.getUTCDate()));
      const startDay = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), startD.getUTCDate()));
      let dayCount = 0;
      while (cursor <= endDay && dayCount < 366) {
        if (cursor >= startDay && (!stopD || cursor <= stopD)) {
          // First occurrence time on this day: use the event's time-of-day
          const occIso = new Date(Date.UTC(
            cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(),
            startD.getUTCHours(), startD.getUTCMinutes(), startD.getUTCSeconds()
          )).toISOString();
          out.push(
            calendarEventToResponse({
              ...row,
              scheduledAt: occIso,
              occurrenceAt: occIso,
              collapsedCount: perDay,
            })
          );
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        dayCount++;
      }
    } else {
      const occurrences = expandOccurrences(
        row.scheduledAt,
        row.repeatInterval,
        row.repeatStopAt ?? null,
        row.exceptions ?? [],
        from,
        to
      );
      for (const occIso of occurrences) {
        out.push(
          calendarEventToResponse({
            ...row,
            scheduledAt: occIso,
            occurrenceAt: occIso,
          })
        );
      }
    }
  }

  // Also include meetings with scheduled_at in range, filtered to user's agents
  const userAgents = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
  const userAgentIds = new Set(userAgents.map(a => a.id));
  const meetingRows = await queries.meetingSession.listMeetingsWithSchedule(db, ws.workspaceId);
  for (const m of meetingRows) {
    if (!m.scheduledAt) continue;
    if (!userAgentIds.has(m.agentId)) continue;
    if (from && m.scheduledAt < from) continue;
    if (to && m.scheduledAt > to) continue;
    if (agentId && m.agentId !== agentId) continue;
    out.push({
      id: m.id,
      agent_id: m.agentId,
      workspace_id: m.workspaceId,
      title: m.title || "Meeting",
      description: m.meetingUrl,
      scheduled_at: m.scheduledAt,
      occurrence_at: m.scheduledAt,
      collapsed_count: null,
      repeat_interval: null,
      repeat_stop_at: null,
      last_triggered_at: null,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
      _type: "meeting" as const,
      _status: m.status,
    });
  }

  out.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));

  return writeJSON(out);
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, err] = await parseBody(req, CreateCalendarEventRequestSchema);
  if (err) return err;

  const agent = await queries.agent.getAgent(
    db,
    body.agent_id,
    ws.workspaceId,
    ctx.userId
  );
  if (!agent) return writeError("agent not found in workspace", 404);

  const scheduledAtDate = new Date(body.scheduled_at);
  const scheduledAtIso = scheduledAtDate.toISOString();

  let repeatStopAtIso: string | null = null;
  if (body.repeat_stop_date) {
    repeatStopAtIso = repeatStopDateToStopAt(body.repeat_stop_date);
    if (new Date(repeatStopAtIso) < scheduledAtDate) {
      return writeError(
        "repeat_stop_date must be on or after the first scheduled occurrence",
        400
      );
    }
  }

  const rawDesc = body.description?.trim() || null;
  const description = rawDesc && isEmptyHtml(rawDesc) ? null : rawDesc;

  const created = await queries.calendarEvent.createCalendarEvent(db, {
    agentId: body.agent_id,
    workspaceId: ws.workspaceId,
    title: body.title,
    description,
    scheduledAt: scheduledAtIso,
    repeatInterval: body.repeat_interval ?? null,
    repeatStopAt: repeatStopAtIso,
  });

  if (body.conversation_id && agent.ownerId) {
    const conv = await queries.conversation.getConversation(db, body.conversation_id, ws.workspaceId);
    if (conv) {
      const eventContent = `${body.title}`;
      const metadata = JSON.stringify({
        calendarEventId: created.id,
        title: body.title,
        scheduledAt: created.scheduledAt,
        ...(created.repeatInterval ? { repeatInterval: created.repeatInterval } : {}),
      });
      const eventMsg = await queries.message.createMessage(db, {
        conversationId: body.conversation_id,
        role: "event",
        content: eventContent,
        metadata,
      });
      broadcastToUser(agent.ownerId, {
        type: "conversation.message",
        conversationId: body.conversation_id,
        message: {
          id: eventMsg.id,
          conversation_id: eventMsg.conversationId,
          role: eventMsg.role as "event",
          content: eventMsg.content,
          task_id: eventMsg.taskId,
          attachment_ids: null,
          metadata: {
            calendarEventId: created.id,
            title: body.title,
            scheduledAt: created.scheduledAt,
            ...(created.repeatInterval ? { repeatInterval: created.repeatInterval } : {}),
          },
          created_at: eventMsg.createdAt,
        },
      }).catch(() => { });
    }
  }

  return writeJSON(calendarEventToResponse(created), 201);
});

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  CreateCalendarEventRequestSchema,
  expandOccurrences,
  isEmptyHtml,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { calendarEventToResponse } from "@/lib/api/responses";
import { repeatStopDateToStopAt } from "@/lib/services/calendar";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const to = req.nextUrl.searchParams.get("to") ?? undefined;

  if (agentId) {
    const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId);
    if (!agent) return writeError("agent not found in workspace", 404);
  }

  const rows = await queries.calendarEvent.listCalendarEvents(
    db,
    ws.workspaceId,
    { agentId, from, to }
  );

  // Expand recurring rows into per-occurrence virtual rows within [from, to].
  // Non-recurring rows pass through with occurrence_at = scheduled_at.
  const out: ReturnType<typeof calendarEventToResponse>[] = [];
  for (const row of rows) {
    if (!row.repeatInterval || !from || !to) {
      out.push(calendarEventToResponse(row));
      continue;
    }
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
    ws.workspaceId
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

  const description =
    body.description && !isEmptyHtml(body.description)
      ? body.description
      : null;

  const created = await queries.calendarEvent.createCalendarEvent(db, {
    agentId: body.agent_id,
    workspaceId: ws.workspaceId,
    title: body.title,
    description,
    scheduledAt: scheduledAtIso,
    repeatInterval: body.repeat_interval ?? null,
    repeatStopAt: repeatStopAtIso,
  });

  return writeJSON(calendarEventToResponse(created), 201);
});

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const idsOnly = req.nextUrl.searchParams.get("ids_only") === "true";
  const conversationId = req.nextUrl.searchParams.get("conversation_id");

  if (idsOnly) {
    if (!conversationId) {
      return NextResponse.json({ error: "conversation_id is required when ids_only=true" }, { status: 400 });
    }
    const messageIds = await queries.messageFlag.listFlaggedMessageIds(db, ctx.userId, ws.workspaceId, conversationId);
    return writeJSON({ message_ids: messageIds });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 30, 1), 100) : 30;
  const before = req.nextUrl.searchParams.get("before") ?? undefined;

  if (before && isNaN(Date.parse(before))) {
    return NextResponse.json({ error: "invalid before timestamp" }, { status: 400 });
  }

  const result = await queries.messageFlag.listFlaggedMessages(db, ctx.userId, ws.workspaceId, { limit, before });

  return writeJSON({ items: result.items, has_more: result.hasMore });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const body = await req.json().catch(() => null) as { messageId?: string } | null;
  if (!body?.messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const msgWorkspaceId = await queries.messageFlag.getMessageWorkspaceId(db, body.messageId);

  if (!msgWorkspaceId) {
    return writeError("message not found", 404);
  }
  if (msgWorkspaceId !== ws.workspaceId) {
    return writeError("message not found", 404);
  }

  const flag = await queries.messageFlag.flagMessage(db, {
    messageId: body.messageId,
    userId: ctx.userId,
    workspaceId: ws.workspaceId,
  });

  return writeJSON({ flagged: true }, flag ? 201 : 200);
});

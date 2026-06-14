import { NextRequest, NextResponse } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { invalidateInboxCounts } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  let body: { conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const db = getDb(ctx.env.DB);

  const conv = await queries.conversation.getConversation(db, body.conversationId, ws.workspaceId);
  if (!conv || conv.userId !== ctx.userId) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  await queries.inbox.markConversationRead(db, ctx.userId, body.conversationId);
  invalidateInboxCounts(ctx.userId, ws.workspaceId).catch(() => {});

  return new NextResponse(null, { status: 204 });
});

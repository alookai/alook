import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { conversationToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("agent id is required", 400);
  }

  const agent = await queries.agent.getAgent(db, id, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("agent not found", 404);
  }

  const url = new URL(req.url);
  const channel = url.searchParams.get("channel") || undefined;
  const exclude = url.searchParams.get("exclude") || undefined;
  const before = url.searchParams.get("before") || undefined;
  const limitParam = url.searchParams.get("limit");

  if (exclude && before) {
    const limit = Math.min(Math.max(Number(limitParam) || 10, 1), 50);
    const prevConvs = await queries.conversation.listPreviousConversations(
      db, ws.workspaceId, ctx.userId, id, exclude, channel, { limit, before },
    );
    return writeJSON({
      conversations: prevConvs.map((c) => ({ id: c.id, created_at: c.createdAt })),
      has_more: prevConvs.length >= limit,
    });
  }

  const conversations = await queries.conversation.listConversationsByAgent(
    db,
    ws.workspaceId,
    ctx.userId,
    id,
    channel
  );

  return writeJSON(conversations.map(conversationToResponse));
});

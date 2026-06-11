import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = ctx.params?.id;
  if (!agentId) {
    return writeError("agent id is required", 400);
  }

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("not found", 404);
  }

  const url = new URL(req.url);
  const before = url.searchParams.get("before") || undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 30, 1), 100) : 30;

  const threads = await queries.conversation.listThreadsByAgent(
    db, ws.workspaceId, agentId, { limit: limit + 1, before }
  );

  const hasMore = threads.length > limit;
  const items = threads.slice(0, limit);

  return writeJSON({
    threads: items.map(t => ({
      id: t.id,
      parent_message_id: t.parentMessageId,
      thread_title: t.threadTitle ?? "",
      reply_count: t.replyCount,
      last_reply_at: t.lastReplyAt,
      last_reply_preview: t.lastReplyPreview ?? "",
      created_at: t.createdAt,
    })),
    has_more: hasMore,
  });
});

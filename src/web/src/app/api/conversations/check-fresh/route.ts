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

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  const agentId = url.searchParams.get("agent_id");
  const channel = url.searchParams.get("channel") || undefined;

  let convId: string;

  if (conversationId) {
    const conv = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
    if (!conv || conv.userId !== ctx.userId) {
      return writeError("not found", 404);
    }
    convId = conv.id;
  } else if (agentId) {
    const conv = await queries.conversation.getOrCreateAgentConversation(
      db,
      ws.workspaceId,
      ctx.userId,
      agentId,
      channel,
    );
    convId = conv.id;
  } else {
    return writeError("conversation_id or agent_id is required", 400);
  }

  const [newestMessageId, messageCount] = await Promise.all([
    queries.message.getNewestMessageId(db, convId),
    queries.message.getActiveMessageCount(db, convId),
  ]);

  return writeJSON({
    conversation_id: convId,
    newest_message_id: newestMessageId,
    message_count: messageCount,
  });
});

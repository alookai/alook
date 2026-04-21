import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeError } from "@/lib/middleware/helpers";
import { broadcastToUser } from "@/lib/broadcast";

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const conversationId = ctx.params?.id;
  const messageId = ctx.params?.messageId;
  if (!conversationId) return writeError("conversation id is required", 400);
  if (!messageId) return writeError("message id is required", 400);

  const conversation = await queries.conversation.getConversation(db, conversationId, ws.workspaceId);
  if (!conversation) return writeError("conversation not found", 404);

  const msg = await queries.message.getMessage(db, messageId);
  if (!msg || msg.conversationId !== conversationId) {
    return writeError("message not found", 404);
  }
  if (msg.status !== "buffered") {
    return writeError("message is not buffered", 400);
  }

  await queries.message.deleteBufferedMessage(db, messageId);

  broadcastToUser(ctx.userId, {
    type: "followup.deleted",
    conversationId,
    messageId,
  }).catch(() => {});

  return new Response(null, { status: 204 });
});

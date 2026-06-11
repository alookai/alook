import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { conversationToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation || conversation.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  return writeJSON(conversationToResponse(conversation));
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation || conversation.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  // Delete tasks first (no cascade on FK)
  await queries.task.deleteTasksByConversation(db, id, ws.workspaceId);
  await queries.inbox.deleteUnreadByConversation(db, id);
  await queries.conversation.deleteConversation(db, id, ws.workspaceId);

  return new Response(null, { status: 204 });
});

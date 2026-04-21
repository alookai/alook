import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";

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
  if (!conversation) {
    return writeError("conversation not found", 404);
  }

  const task = await queries.task.getActiveTaskByConversation(db, id, ws.workspaceId);
  if (!task) {
    return new Response(null, { status: 204 });
  }

  return writeJSON(taskToResponse(task));
});

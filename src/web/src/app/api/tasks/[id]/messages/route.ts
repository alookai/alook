import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { TaskMessageStore } from "@/lib/task-message-store";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("task id is required", 400);
  }

  const task = await queries.task.getTask(db, id, ws.workspaceId);
  if (!task) {
    return writeError("task not found", 404);
  }

  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const sinceParam = req.nextUrl.searchParams.get("since");
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;

  if (sinceParam && isNaN(since!)) {
    return writeError("invalid since parameter", 400);
  }

  const messages = await store.listMessages(id, {
    since,
    excludeTypes: ["tool-result"],
  });

  return writeJSON(messages.map(taskMessageToResponse));
});

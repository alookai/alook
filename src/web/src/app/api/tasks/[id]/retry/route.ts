import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) {
    return writeError("task id is required", 400);
  }

  const task = await queries.task.getTask(db, id, ws.workspaceId);
  if (!task) {
    return writeError("not found", 404);
  }

  const agent = await queries.agent.getAgent(db, task.agentId, ws.workspaceId, ctx.userId);
  if (!agent) {
    return writeError("not found", 404);
  }

  const taskService = new TaskService(db);
  try {
    const { oldTask, newTask } = await taskService.retryTask(id, ws.workspaceId);
    const dateStr = new Date().toISOString().slice(0, 10);
    invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
    broadcastToUser(ctx.userId, { type: "task.updated", taskId: oldTask.id, agentId: oldTask.agentId, status: "superseded" }).catch(() => {});
    broadcastToUser(ctx.userId, { type: "task.updated", taskId: newTask.id, agentId: newTask.agentId, status: "queued" }).catch(() => {});
    return writeJSON(taskToResponse(newTask));
  } catch (e: unknown) {
    return writeError(e instanceof Error ? e.message : "Unknown error", 400);
  }
});

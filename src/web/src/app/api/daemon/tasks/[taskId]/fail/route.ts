import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { FailTaskRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const [body, err] = await parseBody(req, FailTaskRequestSchema);
  if (err) return err;

  const taskService = new TaskService(db);
  try {
    const task = await taskService.failTask(taskId, body.error);
    broadcastToUser(ctx.userId, { type: "task.updated", taskId, status: "failed" }).catch(() => {});
    return writeJSON(taskToResponse(task));
  } catch (e: unknown) {
    return writeError(e instanceof Error ? e.message : "Unknown error", 400);
  }
});

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { CompleteTaskRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const [body, err] = await parseBody(req, CompleteTaskRequestSchema);
  if (err) return err;

  const result = JSON.stringify(body);
  const sessionId = body.session_id || "";

  const taskService = new TaskService(db);
  try {
    const task = await taskService.completeTask(
      taskId,
      result,
      sessionId
    );
    broadcastToUser(ctx.userId, { type: "task.updated", taskId, status: "completed" }).catch(() => {});
    return writeJSON(taskToResponse(task));
  } catch (e: unknown) {
    return writeError(e instanceof Error ? e.message : "Unknown error", 400);
  }
});

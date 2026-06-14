import { NextRequest } from "next/server";
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { CompleteTaskRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, invalidateInboxCounts, cacheKeys } from "@/lib/cache";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const db = getDb(ctx.env.DB)

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
      ctx.workspaceId,
      result,
      sessionId
    );
    const dateStr = new Date().toISOString().slice(0, 10);
    invalidate(cacheKeys.overviewTaskStats(ctx.workspaceId, dateStr)).catch(() => {});
    const conv = await queries.conversation.getConversation(db, task.conversationId, ctx.workspaceId);
    if (conv) {
      invalidateInboxCounts(conv.userId, ctx.workspaceId).catch(() => {});
      broadcastToUser(conv.userId, { type: "task.updated", taskId, agentId: task.agentId, status: "completed" }).catch(() => {});
    }
    return writeJSON(taskToResponse(task));
  } catch (e: unknown) {
    return writeError(e instanceof Error ? e.message : "Unknown error", 400);
  }
});

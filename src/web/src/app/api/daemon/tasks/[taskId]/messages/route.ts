import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import type { TaskMessage } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { ReportMessagesRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { log } from "@/lib/logger";

export const GET = withAuth(async (_req, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const messages = await queries.taskMessage.listTaskMessages(db, taskId, ctx.workspaceId);
  return writeJSON(messages.map(taskMessageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const task = await queries.task.getTask(db, taskId, ctx.workspaceId);
  if (!task) {
    return writeError("task not found", 404);
  }

  const [body, err] = await parseBody(req, ReportMessagesRequestSchema);
  if (err) return err;

  if (body.messages.length === 0) {
    return writeJSON({ status: "ok" });
  }

  const results = await Promise.allSettled(
    body.messages.map((m) =>
      queries.taskMessage.createTaskMessage(db, {
        taskId,
        seq: m.seq,
        type: m.type,
        tool: m.tool || "",
        callId: m.call_id || "",
        content: m.content || "",
        input: m.input,
        output: m.output || "",
      })
    )
  );

  results.forEach((r) => {
    if (r.status === "rejected") {
      log.warn("Failed to create task message", { taskId, err: r.reason });
    }
  });

  const succeeded = body.messages.filter((_, i) => results[i].status === "fulfilled");
  const broadcastable = succeeded.filter((m) => m.type !== "tool-result");
  if (broadcastable.length > 0) {
    const wsMessages: TaskMessage[] = broadcastable.map((m) => ({
      id: "",
      task_id: taskId,
      seq: m.seq,
      type: m.type,
      tool: m.tool || "",
      call_id: m.call_id || "",
      content: m.content || "",
      output: m.output || "",
      ...(m.input ? { input: m.input } : {}),
    }));
    broadcastToUser(ctx.userId, { type: "task.messages", taskId, messages: wsMessages }).catch(() => {});
  }

  return writeJSON({ status: "ok" });
});

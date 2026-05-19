import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import type { TaskMessage } from "@alook/shared"
import { getDb, withD1Retry } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { ReportMessagesRequestSchema } from "@alook/shared";
import { broadcastToUser } from "@/lib/broadcast";
import { TaskMessageStore } from "@/lib/task-message-store";
import { log } from "@/lib/logger";

export const GET = withAuth(async (_req, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)
  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const task = await withD1Retry(() => queries.task.getTask(db, taskId, ctx.workspaceId));
  if (!task) {
    return writeError("task not found", 404);
  }

  const messages = await store.listMessages(taskId, { excludeTypes: ["tool-result"] });
  return writeJSON(messages.map(taskMessageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)
  const store = new TaskMessageStore(
    (env as Env).TASK_MESSAGE_BUCKET,
    (env as Env).CACHE_KV ?? null,
  );

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const task = await withD1Retry(() => queries.task.getTask(db, taskId, ctx.workspaceId));
  if (!task) {
    return writeError("task not found", 404);
  }

  const [body, err] = await parseBody(req, ReportMessagesRequestSchema);
  if (err) return err;

  if (body.messages.length === 0) {
    return writeJSON({ status: "ok" });
  }

  // Write metadata to D1
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

  // Write full messages to R2/KV
  if (succeeded.length > 0) {
    const fullMessages: TaskMessage[] = succeeded.map((m) => ({
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

    await store.appendMessages(taskId, fullMessages).catch((e) => {
      log.warn("Failed to write task messages to R2/KV", { taskId, err: e });
    });
  }

  // Broadcast via WebSocket
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

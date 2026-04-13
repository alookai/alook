import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { taskMessageToResponse } from "@/lib/api/responses";
import { ReportMessagesRequestSchema } from "@alook/shared";
import { log } from "@/lib/logger";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const messages = await queries.taskMessage.listTaskMessages(db, taskId);
  return writeJSON(messages.map(taskMessageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const taskId = ctx.params?.taskId;
  if (!taskId) {
    return writeError("task_id is required", 400);
  }

  const [body, err] = await parseBody(req, ReportMessagesRequestSchema);
  if (err) return err;

  if (body.messages.length === 0) {
    return writeJSON({ status: "ok" });
  }

  for (const m of body.messages) {
    queries.taskMessage.createTaskMessage(db, {
      taskId,
      seq: m.seq,
      type: m.type,
      tool: m.tool || "",
      callId: m.call_id || "",
      content: m.content || "",
      input: m.input,
      output: m.output || "",
    }).catch((e) => {
      log.warn("Failed to create task message", { taskId, err: e });
    });
  }

  return writeJSON({ status: "ok" });
});

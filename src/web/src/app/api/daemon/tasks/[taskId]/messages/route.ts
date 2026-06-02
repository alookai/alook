import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb, withD1Retry } from "@/lib/db";
import type { TaskMessageResponse } from "@alook/shared"
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

  const messages = await withD1Retry(() => queries.taskMessage.listTaskMessages(db, taskId, ctx.workspaceId));
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

  const task = await withD1Retry(() => queries.task.getTask(db, taskId, ctx.workspaceId));
  if (!task) {
    return writeError("task not found", 404);
  }

  const [body, err] = await parseBody(req, ReportMessagesRequestSchema);
  if (err) return err;

  // What we persist (INTENTIONAL — do not "clean up" as dead storage):
  //   - We DROP only "log" and "status" — pure transient runtime noise, never
  //     useful after the fact.
  //   - We KEEP text/tool-use/thinking/tool-result rows even though the chat UI
  //     no longer reads them (since the move to agent-authored `send-dm`, the UI
  //     only consumes type:"error" + the final reply bubble). These rows are
  //     retained for FUTURE DATA ANALYSIS of agent runs (tool usage, reasoning,
  //     etc.). The read paths (listTaskMessages*) filter them out for the UI, but
  //     the rows must stay in storage. Don't delete this write or narrow it to
  //     errors-only.
  const filtered = body.messages.filter((m) => m.type !== "log" && m.type !== "status");
  if (filtered.length === 0) {
    return writeJSON({ status: "ok" });
  }

  const results = await Promise.allSettled(
    filtered.map((m) =>
      queries.taskMessage.createTaskMessage(db, {
        taskId,
        seq: m.seq,
        type: m.type,
        tool: m.tool || "",
        callId: m.call_id || "",
        // tool-result content/input/output are intentionally blanked: those
        // payloads can be very large (full tool stdout, file dumps), so we keep
        // the row (for analysis: which tool ran, when) but not the heavy body.
        content: m.type === "tool-result" ? "" : (m.content || ""),
        input: m.type === "tool-result" ? undefined : m.input,
        output: m.type === "tool-result" ? "" : (m.output || ""),
      })
    )
  );

  results.forEach((r) => {
    if (r.status === "rejected") {
      log.warn("Failed to create task message", { taskId, err: r.reason });
    }
  });

  const succeeded = filtered.filter((_, i) => results[i].status === "fulfilled");
  // Broadcast is a separate concern from storage: we STORE tool-use/thinking/
  // tool-result (for later analysis, above) but don't BROADCAST them — the live
  // chat has no use for them. text is still broadcast (cheap, and harmless if the
  // client ignores it); only type:"error" actually drives UI today.
  const broadcastable = succeeded.filter((m) => m.type !== "tool-result" && m.type !== "tool-use" && m.type !== "thinking");
  if (broadcastable.length > 0) {
    const wsMessages: TaskMessageResponse[] = broadcastable.map((m) => ({
      id: "",
      seq: m.seq,
      type: m.type,
      content: m.content || "",
      output: m.output || "",
    }));
    broadcastToUser(ctx.userId, { type: "task.messages", taskId, messages: wsMessages }).catch(() => {});
  }

  return writeJSON({ status: "ok" });
});

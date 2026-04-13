import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";

function truncateTitle(text: string, maxLen = 50): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  const title = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return title + "...";
}

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const conversation = await queries.conversation.getConversation(db, id);
  if (!conversation || conversation.workspaceId !== ws.workspaceId) {
    return writeError("conversation not found", 404);
  }

  const messages = await queries.message.listMessages(db, id);
  return writeJSON(messages.map(messageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return writeError("invalid request body", 400);
  }

  const content = body.content || "";
  if (!content) {
    return writeError("content is required", 400);
  }

  const conversation = await queries.conversation.getConversation(db, id);
  if (!conversation || conversation.workspaceId !== ws.workspaceId) {
    return writeError("conversation not found", 404);
  }

  const message = await queries.message.createMessage(db, {
    conversationId: id,
    role: "user",
    content,
  });

  // Auto-title: conditional WHERE title = '' ensures only the first message sets it
  queries.conversation.updateConversationTitle(db, id, truncateTitle(content)).catch(() => {});

  const taskService = new TaskService(db);
  try {
    const task = await taskService.enqueueTask(
      conversation.agentId,
      id,
      ws.workspaceId,
      content
    );
    broadcastToUser(ctx.userId, { type: "task.updated", taskId: task.id, status: "queued" }).catch(() => {});
    return writeJSON(
      { message: messageToResponse(message), task: taskToResponse(task) },
      201
    );
  } catch (err: unknown) {
    log.error("enqueueTask error", { err });
    return writeJSON(
      {
        message: messageToResponse(message),
        task: null,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500
    );
  }
});

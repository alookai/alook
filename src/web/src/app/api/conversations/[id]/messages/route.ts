import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, TASK_TYPES, CreateMessageRequestSchema, parsePromptMentions, truncateTitle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 10;

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation || conversation.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  const url = new URL(req.url);
  const aroundTask = url.searchParams.get("around_task");

  if (aroundTask) {
    const messages = await queries.message.listMessagesAroundTask(db, id, aroundTask);
    return writeJSON(messages.map(messageToResponse));
  }

  const limitParam = url.searchParams.get("limit");
  const before = url.searchParams.get("before") || undefined;
  const beforeId = url.searchParams.get("before_id") || undefined;
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : undefined;

  const { messages, has_more } = await queries.message.listMessages(db, id, { limit, before, beforeId });
  return writeJSON({ messages: messages.map(messageToResponse), has_more });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)
  const bucket = (env as Env).EMAIL_BUCKET;

  const id = ctx.params?.id;
  if (!id) {
    return writeError("conversation id is required", 400);
  }

  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let content: string;
  let messageMetadata: Record<string, unknown> | undefined;
  const files: File[] = [];

  if (isMultipart) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return writeError("invalid form data", 400);
    }
    content = (formData.get("content") as string) || "";
    const metaRaw = formData.get("metadata") as string | null;
    if (metaRaw) {
      try { messageMetadata = JSON.parse(metaRaw); } catch { /* ignore malformed */ }
    }
    for (const [key, value] of formData.entries()) {
      if (key === "file" && value instanceof File) {
        files.push(value);
      }
    }
  } else {
    const [body, valErr] = await parseBody(req, CreateMessageRequestSchema);
    if (valErr) return valErr;
    content = body.content;
    messageMetadata = body.metadata;
  }

  if (isMultipart && !content) {
    return writeError("content is required", 400);
  }

  // Validate files before any uploads
  if (files.length > MAX_FILES) {
    return writeError(`too many files (max ${MAX_FILES})`, 400);
  }
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return writeError(`file "${file.name}" exceeds 10 MB limit`, 413);
    }
  }

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation || conversation.userId !== ctx.userId) {
    return writeError("not found", 404);
  }

  // Upload files to R2 and create artifact rows
  const artifactIds: string[] = [];
  for (const file of files) {
    const filename = sanitizeFilename(file.name);
    const fileContentType = file.type || "application/octet-stream";
    const artifactId = "art_" + nanoid();
    const r2Key = `artifacts/${ws.workspaceId}/${conversation.agentId}/${id}/${artifactId}/${filename}`;

    await bucket.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: fileContentType },
    });

    await queries.artifact.createArtifact(db, {
      id: artifactId,
      conversationId: id,
      agentId: conversation.agentId,
      workspaceId: ws.workspaceId,
      filename,
      contentType: fileContentType,
      size: file.size,
      r2Key,
      source: "attachment",
    });

    artifactIds.push(artifactId);
  }

  const message = await queries.message.createMessage(db, {
    conversationId: id,
    role: "user",
    content,
    attachmentIds: artifactIds.length > 0 ? JSON.stringify(artifactIds) : null,
    metadata: messageMetadata ? JSON.stringify(messageMetadata) : null,
  });

  broadcastToUser(ctx.userId, {
    type: "conversation.message",
    conversationId: id,
    message: messageToResponse(message),
  }).catch(() => {});

  // If this is a thread conversation, broadcast thread.reply with actual count
  if (conversation.parentMessageId) {
    queries.message.getActiveMessageCount(db, id).then((count) => {
      broadcastToUser(ctx.userId, {
        type: "thread.reply",
        conversationId: id,
        threadConversationId: id,
        parentMessageId: conversation.parentMessageId!,
        replyCount: count,
      }).catch(() => {});
    }).catch(() => {});
  }

  // Auto-title: conditional WHERE title = '' ensures only the first message sets it
  queries.conversation.updateConversationTitle(db, id, truncateTitle(content)).catch(() => {});

  let enrichedContent = content;
  let mentionContext: Record<string, unknown> | undefined;
  if (content.includes("@")) {
    try {
      const agentList = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
      const { enrichedPrompt, mentions } = parsePromptMentions(content, agentList);
      enrichedContent = enrichedPrompt;
      if (mentions.length > 0) {
        const seen = new Set<string>();
        const uniqueMentions = mentions.filter(m => {
          if (seen.has(m.name)) return false;
          seen.add(m.name);
          return true;
        });
        mentionContext = {
          mentioned_agents: uniqueMentions.map(m => ({
            name: m.name,
            email: m.email,
            ...(m.description ? { description: m.description } : {}),
          })),
        };
      }
    } catch {
      // Fail-open: if agent query fails, pass content through unmodified
    }
  }

  const contextKey = id;
  const quote = messageMetadata?.quote as { messageId?: string; excerpt?: string } | undefined;
  const taskContext: Record<string, unknown> = {
    message_id: message.id,
    ...(artifactIds.length > 0 ? { attachment_ids: artifactIds } : {}),
    ...mentionContext,
    ...(quote ? { quoted_message: { message_id: quote.messageId, excerpt: quote.excerpt } } : {}),
  };
  const traceId = "tr_" + nanoid();
  const taskService = new TaskService(db);
  try {
    const task = await taskService.enqueueTask(
      conversation.agentId,
      id,
      ws.workspaceId,
      enrichedContent,
      TASK_TYPES.USER_DM_MESSAGE,
      {
        contextKey,
        context: Object.keys(taskContext).length > 0 ? taskContext : undefined,
        traceId,
        parentTaskId: null,
      },
    );
    queries.message.updateMessageTaskId(db, message.id, task.id).catch(() => {});
    const dateStr = new Date().toISOString().slice(0, 10);
    invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
    broadcastToUser(ctx.userId, { type: "task.updated", taskId: task.id, agentId: task.agentId, status: "queued" }).catch(() => {});
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

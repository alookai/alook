import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, TASK_TYPES, buildContextKey, CreateMessageRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { log } from "@/lib/logger";
import { broadcastToUser } from "@/lib/broadcast";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 10;

function truncateTitle(text: string, maxLen = 50): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  const title = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return title + "...";
}

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
  if (!conversation) {
    return writeError("conversation not found", 404);
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const before = url.searchParams.get("before") || undefined;
  const beforeId = url.searchParams.get("before_id") || undefined;
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : undefined;

  const messages = await queries.message.listMessages(db, id, { limit, before, beforeId });
  return writeJSON(messages.map(messageToResponse));
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
  let files: File[] = [];

  if (isMultipart) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return writeError("invalid form data", 400);
    }
    content = (formData.get("content") as string) || "";
    for (const [key, value] of formData.entries()) {
      if (key === "file" && value instanceof File) {
        files.push(value);
      }
    }
  } else {
    const [body, valErr] = await parseBody(req, CreateMessageRequestSchema);
    if (valErr) return valErr;
    content = body.content;
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
  if (!conversation) {
    return writeError("conversation not found", 404);
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
  });

  // Auto-title: conditional WHERE title = '' ensures only the first message sets it
  queries.conversation.updateConversationTitle(db, id, truncateTitle(content)).catch(() => {});

  const contextKey = buildContextKey(TASK_TYPES.USER_DM_MESSAGE, { conversationId: id });
  const taskService = new TaskService(db);
  try {
    const task = await taskService.enqueueTask(
      conversation.agentId,
      id,
      ws.workspaceId,
      content,
      TASK_TYPES.USER_DM_MESSAGE,
      {
        contextKey,
        context: artifactIds.length > 0 ? { attachment_ids: artifactIds } : undefined,
      },
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

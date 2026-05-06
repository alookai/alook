import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  queries,
  CreateBufferedMessageRequestSchema,
  parsePromptMentions,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { nanoid } from "nanoid";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { messageToResponse } from "@/lib/api/responses";
import { broadcastToUser } from "@/lib/broadcast";
import { TaskService } from "@/lib/services/task";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_BUFFERED = 20;

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation) return writeError("conversation not found", 404);

  const buffered = await queries.message.listBufferedMessages(db, id);
  return writeJSON(buffered.map(messageToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const bucket = (env as Env).EMAIL_BUCKET;

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation) return writeError("conversation not found", 404);

  const existing = await queries.message.countBufferedMessages(db, id);
  if (existing >= MAX_BUFFERED) {
    return writeError(`maximum ${MAX_BUFFERED} buffered messages reached`, 429);
  }

  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let content: string;
  const files: File[] = [];

  if (isMultipart) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return writeError("invalid form data", 400);
    }
    content = ((formData.get("content") as string) ?? "").trim();
    for (const [key, value] of formData.entries()) {
      if (key === "file" && value instanceof File) {
        files.push(value);
      }
    }
    if (!content) {
      return writeError("content is required", 400);
    }
  } else {
    const [body, valErr] = await parseBody(req, CreateBufferedMessageRequestSchema);
    if (valErr) return valErr;
    content = body.content;
  }

  if (files.length > MAX_FILES) {
    return writeError(`too many files (max ${MAX_FILES})`, 400);
  }
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return writeError(`file "${file.name}" exceeds 10 MB limit`, 413);
    }
  }

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

  let enrichedContent = content;
  if (content.includes("@")) {
    try {
      const agentList = await queries.agent.listAgents(db, ws.workspaceId, ctx.userId);
      const { enrichedPrompt } = parsePromptMentions(content, agentList);
      enrichedContent = enrichedPrompt;
    } catch {
      // Fail-open: pass content through unmodified
    }
  }

  const message = await queries.message.createBufferedMessage(db, {
    conversationId: id,
    content: enrichedContent,
    attachmentIds: artifactIds.length > 0 ? JSON.stringify(artifactIds) : null,
  });

  broadcastToUser(ctx.userId, {
    type: "followup.created",
    conversationId: id,
    message: messageToResponse(message),
  }).catch(() => {});

  // If no active task, dispatch immediately (handles race where task completed
  // just before this message was buffered)
  const activeTask = await queries.task.getActiveTaskByConversation(db, id, ws.workspaceId);
  if (!activeTask) {
    const taskService = new TaskService(db);
    taskService.dispatchNextBufferedMessage(id, ws.workspaceId).catch(() => {});
  }

  return writeJSON({ message: messageToResponse(message) }, 201);
});

export const DELETE = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const conversation = await queries.conversation.getConversation(db, id, ws.workspaceId);
  if (!conversation) return writeError("conversation not found", 404);

  const deleted = await queries.message.deleteAllBufferedMessages(db, id);
  for (const msg of deleted) {
    broadcastToUser(ctx.userId, {
      type: "followup.deleted",
      conversationId: id,
      messageId: msg.id,
    }).catch(() => {});
  }

  return new Response(null, { status: 204 });
});

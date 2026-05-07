import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CreateIssueRequestSchema, IssueStatusSchema, queries, TASK_TYPES } from "@alook/shared";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import { issueToResponse, messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { broadcastToUser } from "@/lib/broadcast";
import type { IssueStatusType } from "@alook/shared";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/\.\./g, "_").slice(0, 255) || "file";
}

function buildIssuePrompt(issue: { title: string; description: string }) {
  const description = issue.description.trim();
  return description ? `${issue.title}\n\n${description}` : issue.title;
}

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const terminalParam = req.nextUrl.searchParams.get("terminal");

  let parsedStatus: IssueStatusType | undefined;
  if (status) {
    const parsed = IssueStatusSchema.safeParse(status);
    if (!parsed.success) return writeError("invalid issue status", 400);
    parsedStatus = parsed.data;
  }

  if (agentId) {
    const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId);
    if (!agent) return writeError("agent not found in workspace", 404);
  }

  const rows = await queries.issue.listIssues(db, ws.workspaceId, {
    agentId,
    status: parsedStatus,
    terminal: terminalParam === null ? undefined : terminalParam === "true",
  });

  return writeJSON(rows.map(issueToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const bucket = (env as Env).EMAIL_BUCKET;

  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let body: { agent_id: string; title: string; description: string };
  const files: File[] = [];

  if (isMultipart) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return writeError("invalid form data", 400);
    }
    const parsed = CreateIssueRequestSchema.safeParse({
      agent_id: formData.get("agent_id"),
      title: formData.get("title"),
      description: formData.get("description") ?? "",
    });
    if (!parsed.success) {
      return writeError("validation error", 400);
    }
    body = parsed.data;
    for (const [key, value] of formData.entries()) {
      if (key === "file" && value instanceof File) {
        files.push(value);
      }
    }
  } else {
    const [parsedBody, err] = await parseBody(req, CreateIssueRequestSchema);
    if (err) return err;
    body = parsedBody;
  }

  if (files.length > MAX_FILES) {
    return writeError(`too many files (max ${MAX_FILES})`, 400);
  }
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return writeError(`file "${file.name}" exceeds 10 MB limit`, 413);
    }
  }

  const agent = await queries.agent.getAgent(db, body.agent_id, ws.workspaceId, ctx.userId);
  if (!agent) return writeError("agent not found in workspace", 404);
  if (!agent.ownerId) return writeError("agent has no owner", 400);

  const conversation = await queries.conversation.createConversation(db, {
    workspaceId: ws.workspaceId,
    agentId: body.agent_id,
    userId: ctx.userId,
    title: `[Issue] ${body.title}`.slice(0, 120),
    type: TASK_TYPES.ISSUE_EVENT,
  });

  const created = await queries.issue.createIssue(db, {
    workspaceId: ws.workspaceId,
    agentId: body.agent_id,
    creatorUserId: ctx.userId,
    conversationId: conversation.id,
    title: body.title,
    description: body.description,
  });

  const artifactIds: string[] = [];
  for (const file of files) {
    const filename = sanitizeFilename(file.name);
    const fileContentType = file.type || "application/octet-stream";
    const artifactId = "art_" + nanoid();
    const r2Key = `artifacts/${ws.workspaceId}/${body.agent_id}/${conversation.id}/${artifactId}/${filename}`;

    await bucket.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: fileContentType },
    });

    await queries.artifact.createArtifact(db, {
      id: artifactId,
      conversationId: conversation.id,
      agentId: body.agent_id,
      workspaceId: ws.workspaceId,
      filename,
      contentType: fileContentType,
      size: file.size,
      r2Key,
      source: "attachment",
    });

    artifactIds.push(artifactId);
  }

  const eventMessage = await queries.message.createMessage(db, {
    conversationId: conversation.id,
    role: "event",
    content: `Issue created: ${created.title}`,
    attachmentIds: artifactIds.length > 0 ? JSON.stringify(artifactIds) : null,
  });

  const prompt = buildIssuePrompt({
    title: created.title,
    description: created.description,
  });

  const taskService = new TaskService(db);
  try {
    const task = await taskService.enqueueTask(
      created.agentId,
      conversation.id,
      ws.workspaceId,
      prompt,
      TASK_TYPES.ISSUE_EVENT,
      {
        contextKey: created.id,
        context: {
          issue_id: created.id,
          ...(artifactIds.length > 0 ? { attachment_ids: artifactIds } : {}),
        },
        traceId: "tr_" + nanoid(),
        parentTaskId: null,
      }
    );
    const issue = await queries.issue.setLatestTask(db, created.id, ws.workspaceId, task.id) ?? created;
    broadcastToUser(ctx.userId, { type: "task.updated", taskId: task.id, agentId: task.agentId, status: "queued" }).catch(() => {});
    return writeJSON(
      {
        issue: issueToResponse(issue),
        message: messageToResponse(eventMessage),
        task: taskToResponse(task),
      },
      201
    );
  } catch (taskErr) {
    await queries.message.createMessage(db, {
      conversationId: conversation.id,
      role: "event",
      content: `Issue dispatch failed: ${taskErr instanceof Error ? taskErr.message : "unknown error"}`,
    });
    return writeError(taskErr instanceof Error ? taskErr.message : "failed to dispatch issue", 500);
  }
});

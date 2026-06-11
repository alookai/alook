import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  CreateIssueCommentBodySchema,
  UpdateIssueRequestSchema,
  TASK_TYPES,
  queries,
} from "@alook/shared";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import { issueToResponse, messageToResponse, taskToResponse } from "@/lib/api/responses";
import { TaskService } from "@/lib/services/task";
import { broadcastToUser } from "@/lib/broadcast";
import { invalidate, cacheKeys } from "@/lib/cache";
import { log } from "@/lib/logger";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId, ctx.userId);
  if (!issue) return writeError("issue not found", 404);
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (agentId && issue.agentId !== agentId) return writeError("issue does not belong to agent", 403);

  let traceId: string | null = null;
  if (issue.latestTaskId) {
    const task = await queries.task.getTask(db, issue.latestTaskId, ws.workspaceId);
    traceId = task?.traceId ?? null;
  }

  const messages = await queries.issue.listIssueMessages(db, id, ws.workspaceId);
  const comments = await queries.issueComment.listComments(db, id, ws.workspaceId);
  const artifacts = issue.conversationId
    ? await queries.artifact.listArtifactsByConversation(db, issue.conversationId, ws.workspaceId)
    : [];
  return writeJSON({
    issue: { ...issueToResponse(issue), trace_id: traceId },
    messages: (messages ?? []).map(messageToResponse),
    comments: comments.map(queries.issueComment.commentToResponse),
    artifacts: artifacts.map(queries.artifact.artifactToResponse),
  });
});

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const existing = await queries.issue.getIssue(db, id, ws.workspaceId, ctx.userId);
  if (!existing) return writeError("issue not found", 404);
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (agentId && existing.agentId !== agentId) return writeError("issue does not belong to agent", 403);

  const [body, err] = await parseBody(req, UpdateIssueRequestSchema);
  if (err) return err;

  // Dispatch-on-assign: assigning an agent to a todo draft issue
  if (body.agent_id) {
    if (existing.status !== "todo") {
      return writeError("Agent assignment is only allowed for todo (draft) issues", 400);
    }

    const agent = await queries.agent.getAgent(db, body.agent_id, ws.workspaceId, ctx.userId);
    if (!agent) return writeError("agent not found in workspace", 404);
    if (!agent.ownerId) return writeError("agent has no owner", 400);

    const conversation = await queries.conversation.createConversation(db, {
      workspaceId: ws.workspaceId,
      agentId: body.agent_id,
      userId: ctx.userId,
      title: `[Issue] ${existing.title}`.slice(0, 120),
      type: TASK_TYPES.ISSUE_EVENT,
    });

    const updated = await queries.issue.updateIssue(db, id, ws.workspaceId, {
      agentId: body.agent_id,
      conversationId: conversation.id,
      status: "in_progress",
    });
    if (!updated) return writeError("issue not found", 404);

    await queries.message.createMessage(db, {
      conversationId: conversation.id,
      role: "event",
      content: `Issue created: ${existing.title}`,
      metadata: JSON.stringify({ issueId: existing.id, title: existing.title, event: "created" as const, agentId: body.agent_id }),
    });

    const prompt = existing.description.trim()
      ? `${existing.title}\n\n${existing.description}`
      : existing.title;

    const taskService = new TaskService(db);
    try {
      const task = await taskService.enqueueTask(
        body.agent_id,
        conversation.id,
        ws.workspaceId,
        prompt,
        TASK_TYPES.ISSUE_EVENT,
        {
          contextKey: conversation.id,
          context: { issue_id: existing.id },
          traceId: "tr_" + nanoid(),
          parentTaskId: null,
        }
      );
      const issue = await queries.issue.setLatestTask(db, id, ws.workspaceId, task.id) ?? updated;
      const dateStr = new Date().toISOString().slice(0, 10);
      invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
      broadcastToUser(ctx.userId, { type: "task.updated", taskId: task.id, agentId: task.agentId, status: "queued" }).catch(() => {});
      return writeJSON({
        ...issueToResponse(issue),
        task: taskToResponse(task),
      });
    } catch (taskErr) {
      await queries.issue.updateIssue(db, id, ws.workspaceId, { status: "todo" });
      await queries.message.createMessage(db, {
        conversationId: conversation.id,
        role: "event",
        content: `Issue dispatch failed: ${taskErr instanceof Error ? taskErr.message : "unknown error"}`,
        metadata: JSON.stringify({ issueId: existing.id, title: existing.title, event: "dispatch_failed" as const }),
      });
      return writeError(taskErr instanceof Error ? taskErr.message : "failed to dispatch issue", 500);
    }
  }

  const updated = await queries.issue.updateIssue(db, id, ws.workspaceId, {
    title: body.title,
    description: body.description,
    status: body.status,
  });
  if (!updated) return writeError("issue not found", 404);

  if (body.status && body.status !== existing.status && existing.conversationId) {
    const eventMsg = await queries.message.createMessage(db, {
      conversationId: existing.conversationId,
      role: "event",
      content: `Issue status changed: ${existing.status} -> ${body.status}`,
      metadata: JSON.stringify({ issueId: existing.id, title: existing.title, event: "status_changed" as const, fromStatus: existing.status, toStatus: body.status }),
    });
    broadcastToUser(ctx.userId, {
      type: "conversation.message",
      conversationId: existing.conversationId,
      message: messageToResponse(eventMsg),
    }).catch(() => {});
  }

  return writeJSON(issueToResponse(updated));
});

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId, ctx.userId);
  if (!issue) return writeError("issue not found", 404);

  if (issue.conversationId) {
    const taskService = new TaskService(db);
    try {
      const task = issue.latestTaskId
        ? await queries.task.getTask(db, issue.latestTaskId, ws.workspaceId)
        : null;
      const reason = "Task cancelled: issue deleted";
      if (task?.traceId) {
        await taskService.cancelTrace(task.traceId, ws.workspaceId, { reason });
      } else {
        await taskService.cancelActiveTask(issue.conversationId, ws.workspaceId, { reason });
      }
    } catch (err) {
      log.warn("failed to cancel tasks during issue deletion", { issueId: id, err });
    }
  }

  await queries.issue.deleteIssue(db, id, ws.workspaceId);

  return new Response(null, { status: 204 });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId, ctx.userId);
  if (!issue) return writeError("issue not found", 404);
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (agentId && issue.agentId !== agentId) return writeError("issue does not belong to agent", 403);

  const [body, err] = await parseBody(req, CreateIssueCommentBodySchema);
  if (err) return err;

  const authorType = agentId ? ("agent" as const) : ("user" as const);
  const authorId = agentId ?? ctx.userId;

  const comment = await queries.issueComment.createComment(db, {
    issueId: id,
    workspaceId: ws.workspaceId,
    authorType,
    authorId,
    content: body.content,
  });

  await queries.issue.updateIssue(db, id, ws.workspaceId, {});

  return writeJSON({ comment: queries.issueComment.commentToResponse(comment) }, 201);
});

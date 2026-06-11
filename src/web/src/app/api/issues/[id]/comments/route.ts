import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  CreateIssueCommentBodySchema,
  TASK_TYPES,
  isTerminalIssueStatus,
  queries,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import { broadcastToUser } from "@/lib/broadcast";
import { TaskService } from "@/lib/services/task";
import { invalidate, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId, ctx.userId);
  if (!issue) return writeError("issue not found", 404);

  const comments = await queries.issueComment.listComments(db, id, ws.workspaceId);
  return writeJSON({ comments: comments.map(queries.issueComment.commentToResponse) });
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

  const response = queries.issueComment.commentToResponse(comment);

  broadcastToUser(issue.creatorUserId, {
    type: "issue.comment",
    issueId: id,
    comment: response,
  }).catch(() => {});

  // Re-dispatch agent when user comments on a non-terminal, non-working issue
  if (authorType === "user" && !isTerminalIssueStatus(issue.status) && issue.agentId && issue.conversationId) {
    const activeTask = await queries.task.getActiveTaskByConversation(
      db, issue.conversationId, ws.workspaceId
    );
    if (!activeTask) {
      const taskService = new TaskService(db);
      const prompt = `${issue.title}\n\nUser feedback: "${body.content}"`;


      try {
        const existingTraceId = issue.latestTaskId
          ? (await queries.task.getTask(db, issue.latestTaskId, ws.workspaceId))?.traceId ?? null
          : null;

        const task = await taskService.enqueueTask(
          issue.agentId,
          issue.conversationId,
          ws.workspaceId,
          prompt,
          TASK_TYPES.ISSUE_EVENT,
          {
            contextKey: issue.conversationId,
            context: { issue_id: issue.id },
            traceId: existingTraceId,
            parentTaskId: null,
          }
        );
        await queries.issue.setLatestTask(db, id, ws.workspaceId, task.id);
        const dateStr = new Date().toISOString().slice(0, 10);
        invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)).catch(() => {});
      } catch {
        // Non-fatal: comment is saved, dispatch failure doesn't block
      }
    }
  }

  return writeJSON({ comment: response }, 201);
});

import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  CreateIssueCommentBodySchema,
  UpdateIssueRequestSchema,
  queries,
} from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import { issueToResponse, messageToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId);
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
  const artifacts = await queries.artifact.listArtifactsByConversation(
    db,
    issue.conversationId,
    ws.workspaceId,
  );
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

  const existing = await queries.issue.getIssue(db, id, ws.workspaceId);
  if (!existing) return writeError("issue not found", 404);
  const agentId = req.nextUrl.searchParams.get("agentId");
  if (agentId && existing.agentId !== agentId) return writeError("issue does not belong to agent", 403);

  const [body, err] = await parseBody(req, UpdateIssueRequestSchema);
  if (err) return err;

  const updated = await queries.issue.updateIssue(db, id, ws.workspaceId, {
    title: body.title,
    description: body.description,
    status: body.status,
  });
  if (!updated) return writeError("issue not found", 404);

  if (body.status && body.status !== existing.status) {
    await queries.message.createMessage(db, {
      conversationId: existing.conversationId,
      role: "event",
      content: `Issue status changed: ${existing.status} -> ${body.status}`,
    });
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

  const deleted = await queries.issue.deleteIssue(db, id, ws.workspaceId);
  if (!deleted) return writeError("issue not found", 404);

  return new Response(null, { status: 204 });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);
  const id = ctx.params?.id;
  if (!id) return writeError("issue id is required", 400);

  const issue = await queries.issue.getIssue(db, id, ws.workspaceId);
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

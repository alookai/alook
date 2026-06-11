import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { issue, message } from "../schema";
import type { Database } from "../index";
import { TERMINAL_ISSUE_STATUSES, type IssueStatusType } from "../../constants";

const ACTIVE_STATUSES: IssueStatusType[] = ["todo", "in_progress", "review"];

export async function createIssue(
  db: Database,
  data: {
    workspaceId: string;
    agentId: string | null;
    creatorUserId: string;
    conversationId: string | null;
    title: string;
    description: string;
    status?: IssueStatusType;
  }
) {
  const now = new Date().toISOString();
  const rows = await db
    .insert(issue)
    .values({
      workspaceId: data.workspaceId,
      agentId: data.agentId,
      creatorUserId: data.creatorUserId,
      conversationId: data.conversationId,
      title: data.title,
      description: data.description,
      status: data.status ?? "todo",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0]!;
}

export async function getIssue(db: Database, id: string, workspaceId: string, userId?: string) {
  const conditions = [eq(issue.id, id), eq(issue.workspaceId, workspaceId)];
  if (userId) conditions.push(eq(issue.creatorUserId, userId));
  const rows = await db
    .select()
    .from(issue)
    .where(and(...conditions));
  return rows[0] ?? null;
}

export async function getIssueByConversation(db: Database, conversationId: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(issue)
    .where(and(eq(issue.conversationId, conversationId), eq(issue.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function listIssues(
  db: Database,
  workspaceId: string,
  opts: { userId: string; agentId?: string; status?: IssueStatusType; terminal?: boolean }
) {
  const conditions = [eq(issue.workspaceId, workspaceId), eq(issue.creatorUserId, opts.userId)];
  if (opts.agentId) conditions.push(eq(issue.agentId, opts.agentId));
  if (opts.status) conditions.push(eq(issue.status, opts.status));
  if (opts.terminal !== undefined) {
    const terminal = [...TERMINAL_ISSUE_STATUSES];
    conditions.push(
      opts.terminal
        ? inArray(issue.status, terminal)
        : inArray(issue.status, ACTIVE_STATUSES)
    );
  }

  return db
    .select()
    .from(issue)
    .where(and(...conditions))
    .orderBy(desc(issue.updatedAt));
}

export async function updateIssue(
  db: Database,
  id: string,
  workspaceId: string,
  patch: {
    title?: string;
    description?: string;
    status?: IssueStatusType;
    latestTaskId?: string | null;
    agentId?: string;
    conversationId?: string;
  }
) {
  const now = new Date().toISOString();
  const terminal = patch.status
    ? (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(patch.status)
    : undefined;
  const values: {
    title?: string;
    description?: string;
    status?: IssueStatusType;
    latestTaskId?: string | null;
    agentId?: string;
    conversationId?: string;
    updatedAt: string;
    completedAt?: string | null;
  } = { updatedAt: now };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.latestTaskId !== undefined) values.latestTaskId = patch.latestTaskId;
  if (patch.agentId !== undefined) values.agentId = patch.agentId;
  if (patch.conversationId !== undefined) values.conversationId = patch.conversationId;
  if (terminal !== undefined) values.completedAt = terminal ? now : null;
  const rows = await db
    .update(issue)
    .set(values)
    .where(and(eq(issue.id, id), eq(issue.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function setLatestTask(
  db: Database,
  id: string,
  workspaceId: string,
  latestTaskId: string | null
) {
  return updateIssue(db, id, workspaceId, { latestTaskId });
}

export async function deleteIssue(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .delete(issue)
    .where(and(eq(issue.id, id), eq(issue.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function listIssueMessages(
  db: Database,
  issueId: string,
  workspaceId: string
) {
  const row = await getIssue(db, issueId, workspaceId);
  if (!row) return null;
  if (!row.conversationId) return [];
  const rows = await db
    .select()
    .from(message)
    .where(and(eq(message.conversationId, row.conversationId), eq(message.status, "active")))
    .orderBy(asc(message.createdAt), asc(message.id));
  return rows;
}

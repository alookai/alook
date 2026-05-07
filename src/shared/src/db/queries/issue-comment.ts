import { and, asc, eq } from "drizzle-orm";
import { issueComment } from "../schema";
import type { Database } from "../index";

export async function createComment(
  db: Database,
  data: {
    issueId: string;
    workspaceId: string;
    authorType: "user" | "agent";
    authorId: string;
    content: string;
  }
) {
  const rows = await db
    .insert(issueComment)
    .values({
      issueId: data.issueId,
      workspaceId: data.workspaceId,
      authorType: data.authorType,
      authorId: data.authorId,
      content: data.content,
    })
    .returning();
  return rows[0]!;
}

export async function listComments(
  db: Database,
  issueId: string,
  workspaceId: string
) {
  return db
    .select()
    .from(issueComment)
    .where(
      and(
        eq(issueComment.issueId, issueId),
        eq(issueComment.workspaceId, workspaceId)
      )
    )
    .orderBy(asc(issueComment.createdAt));
}

export async function deleteComment(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .delete(issueComment)
    .where(
      and(
        eq(issueComment.id, id),
        eq(issueComment.workspaceId, workspaceId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export function commentToResponse(row: typeof issueComment.$inferSelect) {
  return {
    id: row.id,
    issue_id: row.issueId,
    workspace_id: row.workspaceId,
    author_type: row.authorType as "user" | "agent",
    author_id: row.authorId,
    content: row.content,
    created_at: row.createdAt,
  };
}

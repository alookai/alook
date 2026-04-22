import { eq, and, gt, isNull } from "drizzle-orm";
import { workspaceInvite, workspace, user } from "../schema";
import type { Database } from "../index";

export async function createInvite(
  db: Database,
  data: { workspaceId: string; createdBy: string; expiresAt: string }
) {
  const rows = await db
    .insert(workspaceInvite)
    .values({
      workspaceId: data.workspaceId,
      createdBy: data.createdBy,
      expiresAt: data.expiresAt,
    })
    .returning();
  return rows[0]!;
}

export async function getInviteByToken(db: Database, token: string) {
  const rows = await db
    .select({
      id: workspaceInvite.id,
      workspaceId: workspaceInvite.workspaceId,
      token: workspaceInvite.token,
      createdBy: workspaceInvite.createdBy,
      usedBy: workspaceInvite.usedBy,
      usedAt: workspaceInvite.usedAt,
      expiresAt: workspaceInvite.expiresAt,
      createdAt: workspaceInvite.createdAt,
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      creatorName: user.name,
      creatorEmail: user.email,
    })
    .from(workspaceInvite)
    .innerJoin(workspace, eq(workspaceInvite.workspaceId, workspace.id))
    .innerJoin(user, eq(workspaceInvite.createdBy, user.id))
    .where(eq(workspaceInvite.token, token));
  return rows[0] ?? null;
}

export async function listActiveInvites(db: Database, workspaceId: string) {
  return db
    .select()
    .from(workspaceInvite)
    .where(
      and(
        eq(workspaceInvite.workspaceId, workspaceId),
        isNull(workspaceInvite.usedBy),
        gt(workspaceInvite.expiresAt, new Date().toISOString())
      )
    );
}

export async function redeemInvite(db: Database, token: string, userId: string) {
  const now = new Date().toISOString();
  const rows = await db
    .update(workspaceInvite)
    .set({ usedBy: userId, usedAt: now })
    .where(
      and(
        eq(workspaceInvite.token, token),
        isNull(workspaceInvite.usedBy),
        gt(workspaceInvite.expiresAt, now)
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function deleteInvite(db: Database, inviteId: string, workspaceId: string) {
  const rows = await db
    .delete(workspaceInvite)
    .where(
      and(
        eq(workspaceInvite.id, inviteId),
        eq(workspaceInvite.workspaceId, workspaceId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

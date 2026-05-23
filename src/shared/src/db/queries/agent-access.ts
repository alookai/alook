import { eq, and } from "drizzle-orm";
import { agentAccess, user } from "../schema";
import type { Database } from "../index";

export async function listAgentAccess(db: Database, agentId: string, workspaceId: string) {
  return db
    .select({
      id: agentAccess.id,
      agentId: agentAccess.agentId,
      workspaceId: agentAccess.workspaceId,
      userId: agentAccess.userId,
      createdAt: agentAccess.createdAt,
      userName: user.name,
      userEmail: user.email,
    })
    .from(agentAccess)
    .innerJoin(user, eq(agentAccess.userId, user.id))
    .where(and(eq(agentAccess.agentId, agentId), eq(agentAccess.workspaceId, workspaceId)));
}

export async function grantAgentAccess(db: Database, data: { agentId: string; workspaceId: string; userId: string }) {
  const rows = await db
    .insert(agentAccess)
    .values({ agentId: data.agentId, workspaceId: data.workspaceId, userId: data.userId })
    .returning();
  return rows[0]!;
}

export async function revokeAgentAccess(db: Database, agentId: string, workspaceId: string, userId: string) {
  const rows = await db
    .delete(agentAccess)
    .where(and(eq(agentAccess.agentId, agentId), eq(agentAccess.workspaceId, workspaceId), eq(agentAccess.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

export async function hasAgentAccess(db: Database, agentId: string, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentAccess.id })
    .from(agentAccess)
    .where(and(eq(agentAccess.agentId, agentId), eq(agentAccess.workspaceId, workspaceId), eq(agentAccess.userId, userId)));
  return rows.length > 0;
}

export async function getAllAgentAccessForWorkspace(db: Database, workspaceId: string) {
  return db
    .select({
      agentId: agentAccess.agentId,
      userId: agentAccess.userId,
    })
    .from(agentAccess)
    .where(eq(agentAccess.workspaceId, workspaceId));
}

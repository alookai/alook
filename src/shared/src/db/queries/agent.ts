import { eq, and } from "drizzle-orm";
import { agent, agentAccess } from "../schema";
import type { Database } from "../index";
import { isPublic } from "../../utils/visibility";

export async function getAgent(db: Database, id: string, workspaceId: string, userId?: string) {
  const rows = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, id), eq(agent.workspaceId, workspaceId)));
  const row = rows[0] ?? null;
  if (!row || !userId) return row;
  if (isPublic(row.visibility) || row.ownerId === userId) return row;
  const access = await db
    .select({ id: agentAccess.id })
    .from(agentAccess)
    .where(and(eq(agentAccess.agentId, id), eq(agentAccess.workspaceId, workspaceId), eq(agentAccess.userId, userId)));
  return access.length > 0 ? row : null;
}

export async function getAgentByHandle(db: Database, emailHandle: string) {
  const rows = await db
    .select()
    .from(agent)
    .where(eq(agent.emailHandle, emailHandle));
  return rows[0] ?? null;
}

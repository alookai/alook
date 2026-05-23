import { eq, and, desc, or, exists, inArray } from "drizzle-orm";
import { agent, agentAccess } from "../schema";
import type { Database } from "../index";

export async function getAgent(db: Database, id: string, workspaceId: string, userId?: string) {
  const rows = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, id), eq(agent.workspaceId, workspaceId)));
  const row = rows[0] ?? null;
  if (!row || !userId) return row;
  if (row.visibility === "public" || row.ownerId === userId) return row;
  const access = await db
    .select({ id: agentAccess.id })
    .from(agentAccess)
    .where(and(eq(agentAccess.agentId, id), eq(agentAccess.workspaceId, workspaceId), eq(agentAccess.userId, userId)));
  return access.length > 0 ? row : null;
}

export async function listAgents(db: Database, workspaceId: string, userId?: string) {
  if (!userId) {
    return db.select().from(agent).where(eq(agent.workspaceId, workspaceId)).orderBy(desc(agent.createdAt));
  }
  return db
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.workspaceId, workspaceId),
        or(
          eq(agent.visibility, "public"),
          eq(agent.ownerId, userId),
          exists(
            db.select({ id: agentAccess.id }).from(agentAccess).where(
              and(
                eq(agentAccess.agentId, agent.id),
                eq(agentAccess.workspaceId, agent.workspaceId),
                eq(agentAccess.userId, userId)
              )
            )
          )
        )
      )
    )
    .orderBy(desc(agent.createdAt));
}

export async function createAgent(
  db: Database,
  data: {
    workspaceId: string;
    name: string;
    description?: string;
    instructions?: string;
    avatarUrl?: string | null;
    runtimeId?: string | null;
    runtimeMode?: string;
    runtimeConfig?: unknown;
    visibility?: string;
    maxConcurrentTasks?: number;
    ownerId?: string | null;
    tools?: unknown;
    triggers?: unknown;
    emailHandle?: string | null;
  }
) {
  const rows = await db
    .insert(agent)
    .values({
      workspaceId: data.workspaceId,
      name: data.name,
      runtimeId: data.runtimeId ?? null,
      description: data.description ?? "",
      instructions: data.instructions ?? "",
      avatarUrl: data.avatarUrl ?? null,
      runtimeMode: data.runtimeMode ?? "local",
      runtimeConfig: data.runtimeConfig ?? null,
      visibility: data.visibility ?? "private",
      maxConcurrentTasks: data.maxConcurrentTasks ?? 6,
      ownerId: data.ownerId ?? null,
      tools: data.tools ?? null,
      triggers: data.triggers ?? null,
      emailHandle: data.emailHandle ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function deleteAgent(
  db: Database,
  id: string,
  workspaceId: string,
  ownerId?: string
) {
  const conditions = [eq(agent.id, id), eq(agent.workspaceId, workspaceId)];
  if (ownerId) conditions.push(eq(agent.ownerId, ownerId));
  const rows = await db
    .delete(agent)
    .where(and(...conditions))
    .returning();
  return rows[0] ?? null;
}

export async function updateAgent(
  db: Database,
  id: string,
  workspaceId: string,
  data: {
    name?: string;
    description?: string;
    instructions?: string;
    runtimeId?: string | null;
    runtimeConfig?: unknown;
    visibility?: string;
    avatarUrl?: string | null;
  },
  ownerId?: string
) {
  const conditions = [eq(agent.id, id), eq(agent.workspaceId, workspaceId)];
  if (ownerId) conditions.push(eq(agent.ownerId, ownerId));
  const rows = await db
    .update(agent)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(...conditions))
    .returning();
  return rows[0] ?? null;
}

export async function updateAgentStatus(
  db: Database,
  id: string,
  workspaceId: string,
  status: string
) {
  const rows = await db
    .update(agent)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(agent.id, id), eq(agent.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function getAgentByHandle(db: Database, emailHandle: string) {
  const rows = await db
    .select()
    .from(agent)
    .where(eq(agent.emailHandle, emailHandle));
  return rows[0] ?? null;
}

export async function getAgentsByIds(db: Database, ids: string[], workspaceId: string) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(agent)
    .where(and(inArray(agent.id, ids), eq(agent.workspaceId, workspaceId)));
}

export async function getAllAgentsForWorkspace(db: Database, workspaceId: string) {
  return db.select().from(agent).where(eq(agent.workspaceId, workspaceId)).orderBy(desc(agent.createdAt));
}

export async function getAllHandlesForWorkspace(db: Database, workspaceId: string) {
  return db
    .select({ id: agent.id, emailHandle: agent.emailHandle })
    .from(agent)
    .where(eq(agent.workspaceId, workspaceId));
}

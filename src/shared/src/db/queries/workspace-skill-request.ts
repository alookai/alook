import { eq, and, inArray, lt } from "drizzle-orm";
import { workspaceSkillRequest } from "../schema";
import type { Database } from "../index";

export async function createRequest(
  db: Database,
  data: {
    workspaceId: string;
    agentId: string;
    runtime: string;
  },
) {
  const rows = await db
    .insert(workspaceSkillRequest)
    .values(data)
    .returning();
  return rows[0]!;
}

export async function getPendingByWorkspace(
  db: Database,
  workspaceId: string,
) {
  return db
    .select()
    .from(workspaceSkillRequest)
    .where(
      and(
        eq(workspaceSkillRequest.workspaceId, workspaceId),
        eq(workspaceSkillRequest.status, "pending"),
      ),
    );
}

export async function markDispatched(db: Database, ids: string[]) {
  if (ids.length === 0) return;
  await db
    .update(workspaceSkillRequest)
    .set({ status: "dispatched", updatedAt: new Date().toISOString() })
    .where(inArray(workspaceSkillRequest.id, ids));
}

export async function completeRequest(
  db: Database,
  id: string,
  result: unknown,
) {
  const rows = await db
    .update(workspaceSkillRequest)
    .set({
      status: "completed",
      result: JSON.stringify(result),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaceSkillRequest.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function getRequest(db: Database, id: string) {
  const rows = await db
    .select()
    .from(workspaceSkillRequest)
    .where(eq(workspaceSkillRequest.id, id));
  return rows[0] ?? null;
}

export async function expireStale(db: Database, workspaceId: string) {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  await db
    .delete(workspaceSkillRequest)
    .where(
      and(
        eq(workspaceSkillRequest.workspaceId, workspaceId),
        lt(workspaceSkillRequest.createdAt, cutoff),
      ),
    );
}

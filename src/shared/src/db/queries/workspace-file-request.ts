import { eq, and, inArray, lt } from "drizzle-orm";
import { workspaceFileRequest } from "../schema";
import type { Database } from "../index";

export async function createRequest(
  db: Database,
  data: {
    workspaceId: string;
    agentId: string;
    requestType: string;
    path: string;
  },
) {
  const rows = await db
    .insert(workspaceFileRequest)
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
    .from(workspaceFileRequest)
    .where(
      and(
        eq(workspaceFileRequest.workspaceId, workspaceId),
        eq(workspaceFileRequest.status, "pending"),
      ),
    );
}

export async function markDispatched(db: Database, ids: string[]) {
  if (ids.length === 0) return;
  await db
    .update(workspaceFileRequest)
    .set({ status: "dispatched", updatedAt: new Date().toISOString() })
    .where(inArray(workspaceFileRequest.id, ids));
}

export async function completeRequest(
  db: Database,
  id: string,
  result: unknown,
) {
  const rows = await db
    .update(workspaceFileRequest)
    .set({
      status: "completed",
      result: JSON.stringify(result),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaceFileRequest.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function getRequest(db: Database, id: string) {
  const rows = await db
    .select()
    .from(workspaceFileRequest)
    .where(eq(workspaceFileRequest.id, id));
  return rows[0] ?? null;
}

export async function expireStale(db: Database, workspaceId: string) {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  await db
    .delete(workspaceFileRequest)
    .where(
      and(
        eq(workspaceFileRequest.workspaceId, workspaceId),
        lt(workspaceFileRequest.createdAt, cutoff),
      ),
    );
}

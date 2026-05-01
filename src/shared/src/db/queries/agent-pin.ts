import { eq, and } from "drizzle-orm";
import { agentPin } from "../schema";
import type { Database } from "../index";

export async function listPins(db: Database, workspaceId: string, userId: string) {
  return db
    .select()
    .from(agentPin)
    .where(and(eq(agentPin.workspaceId, workspaceId), eq(agentPin.userId, userId)))
    .orderBy(agentPin.order);
}

export async function pinAgent(db: Database, data: { agentId: string; workspaceId: string; userId: string; order?: number }) {
  const { order, ...rest } = data;
  const rows = await db
    .insert(agentPin)
    .values({ ...rest, order: order ?? 0 })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function unpinAgent(db: Database, agentId: string, workspaceId: string, userId: string) {
  const rows = await db
    .delete(agentPin)
    .where(
      and(
        eq(agentPin.agentId, agentId),
        eq(agentPin.workspaceId, workspaceId),
        eq(agentPin.userId, userId),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function reorderPins(db: Database, workspaceId: string, userId: string, agentIds: string[]) {
  const stmts = agentIds.map((agentId, i) =>
    db
      .insert(agentPin)
      .values({ agentId, workspaceId, userId, order: i })
      .onConflictDoUpdate({
        target: [agentPin.agentId, agentPin.workspaceId, agentPin.userId],
        set: { order: i },
      })
  );
  await db.batch(stmts as [typeof stmts[0], ...typeof stmts]);
}

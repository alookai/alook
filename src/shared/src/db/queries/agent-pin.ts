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
    .values({ ...rest, order: order ?? 0, pinned: 1 })
    .onConflictDoUpdate({
      target: [agentPin.agentId, agentPin.workspaceId, agentPin.userId],
      set: { pinned: 1 },
    })
    .returning();
  return rows[0] ?? null;
}

export async function unpinAgent(db: Database, agentId: string, workspaceId: string, userId: string) {
  const rows = await db
    .update(agentPin)
    .set({ pinned: 0 })
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

export async function reorderPins(
  db: Database,
  workspaceId: string,
  userId: string,
  pinnedIds: string[],
  unpinnedIds: string[],
) {
  const stmts = [
    ...pinnedIds.map((agentId, i) =>
      db
        .insert(agentPin)
        .values({ agentId, workspaceId, userId, order: i, pinned: 1 })
        .onConflictDoUpdate({
          target: [agentPin.agentId, agentPin.workspaceId, agentPin.userId],
          set: { order: i, pinned: 1 },
        })
    ),
    ...unpinnedIds.map((agentId, i) =>
      db
        .insert(agentPin)
        .values({ agentId, workspaceId, userId, order: i, pinned: 0 })
        .onConflictDoUpdate({
          target: [agentPin.agentId, agentPin.workspaceId, agentPin.userId],
          set: { order: i, pinned: 0 },
        })
    ),
  ];
  if (stmts.length > 0) {
    await db.batch(stmts as [typeof stmts[0], ...typeof stmts]);
  }
}

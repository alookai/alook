import { eq, and, asc, sql } from "drizzle-orm";
import { agentPin } from "../schema";
import type { Database } from "../index";

export async function listPins(db: Database, workspaceId: string, userId: string) {
  return db
    .select()
    .from(agentPin)
    .where(and(eq(agentPin.workspaceId, workspaceId), eq(agentPin.userId, userId)))
    .orderBy(asc(agentPin.position));
}

export async function pinAgent(db: Database, data: { agentId: string; workspaceId: string; userId: string }) {
  const rows = await db
    .insert(agentPin)
    .values({
      ...data,
      position: sql<number>`COALESCE((SELECT MAX(${agentPin.position}) FROM ${agentPin} WHERE ${agentPin.workspaceId} = ${data.workspaceId} AND ${agentPin.userId} = ${data.userId}), -1) + 1`,
    })
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

export async function reorderPins(
  db: Database,
  workspaceId: string,
  userId: string,
  orderedAgentIds: string[],
) {
  await (db as any).batch(
    orderedAgentIds.map((id, i) =>
      db
        .update(agentPin)
        .set({ position: i })
        .where(
          and(
            eq(agentPin.agentId, id),
            eq(agentPin.workspaceId, workspaceId),
            eq(agentPin.userId, userId),
          )
        )
    )
  );
}

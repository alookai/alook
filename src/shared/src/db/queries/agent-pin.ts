import { eq, and } from "drizzle-orm";
import { agentPin } from "../schema";
import type { Database } from "../index";

export async function listPins(db: Database, workspaceId: string, userId: string) {
  return db
    .select()
    .from(agentPin)
    .where(and(eq(agentPin.workspaceId, workspaceId), eq(agentPin.userId, userId)));
}

export async function pinAgent(db: Database, data: { agentId: string; workspaceId: string; userId: string }) {
  const rows = await db
    .insert(agentPin)
    .values(data)
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

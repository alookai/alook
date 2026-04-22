import { eq, and } from "drizzle-orm";
import { agentWhitelist } from "../schema";
import type { Database } from "../index";

export async function getWhitelist(db: Database, agentId: string, workspaceId: string) {
  return db
    .select()
    .from(agentWhitelist)
    .where(and(eq(agentWhitelist.agentId, agentId), eq(agentWhitelist.workspaceId, workspaceId)));
}

export async function addWhitelist(db: Database, agentId: string, workspaceId: string, email: string) {
  const rows = await db
    .insert(agentWhitelist)
    .values({ agentId, workspaceId, email })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function removeWhitelist(db: Database, id: string, agentId: string, workspaceId: string) {
  const rows = await db
    .delete(agentWhitelist)
    .where(
      and(
        eq(agentWhitelist.id, id),
        eq(agentWhitelist.agentId, agentId),
        eq(agentWhitelist.workspaceId, workspaceId),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function removeWhitelistByEmail(db: Database, agentId: string, workspaceId: string, email: string) {
  const rows = await db
    .delete(agentWhitelist)
    .where(
      and(
        eq(agentWhitelist.agentId, agentId),
        eq(agentWhitelist.workspaceId, workspaceId),
        eq(agentWhitelist.email, email),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function isWhitelisted(db: Database, agentId: string, workspaceId: string, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentWhitelist.id })
    .from(agentWhitelist)
    .where(
      and(
        eq(agentWhitelist.agentId, agentId),
        eq(agentWhitelist.workspaceId, workspaceId),
        eq(agentWhitelist.email, email)
      )
    )
    .limit(1);
  return rows.length > 0;
}

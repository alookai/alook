import { eq, and } from "drizzle-orm";
import { agentGreylist, agentWhitelist, agent } from "../schema";
import type { Database } from "../index";
import { parseEmailHandle } from "../../utils/email";

export async function getGreylist(db: Database, agentId: string, workspaceId: string) {
  return db
    .select()
    .from(agentGreylist)
    .where(and(eq(agentGreylist.agentId, agentId), eq(agentGreylist.workspaceId, workspaceId)));
}

export async function addGreylist(db: Database, agentId: string, workspaceId: string, email: string) {
  // Mutual exclusion: reject if already whitelisted
  const whitelisted = await db
    .select({ id: agentWhitelist.id })
    .from(agentWhitelist)
    .where(
      and(
        eq(agentWhitelist.agentId, agentId),
        eq(agentWhitelist.workspaceId, workspaceId),
        eq(agentWhitelist.email, email),
      )
    )
    .limit(1);
  if (whitelisted.length > 0) return null;

  const rows = await db
    .insert(agentGreylist)
    .values({ agentId, workspaceId, email })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function removeGreylist(db: Database, id: string, agentId: string, workspaceId: string) {
  const rows = await db
    .delete(agentGreylist)
    .where(
      and(
        eq(agentGreylist.id, id),
        eq(agentGreylist.agentId, agentId),
        eq(agentGreylist.workspaceId, workspaceId),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function removeGreylistByEmail(db: Database, agentId: string, workspaceId: string, email: string) {
  const rows = await db
    .delete(agentGreylist)
    .where(
      and(
        eq(agentGreylist.agentId, agentId),
        eq(agentGreylist.workspaceId, workspaceId),
        eq(agentGreylist.email, email),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function isGreylisted(db: Database, agentId: string, workspaceId: string, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentGreylist.id })
    .from(agentGreylist)
    .where(
      and(
        eq(agentGreylist.agentId, agentId),
        eq(agentGreylist.workspaceId, workspaceId),
        eq(agentGreylist.email, email)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Pre-fetch greylist for O(1) batch lookups. */
export async function buildGreylistSet(
  db: Database, agentId: string, workspaceId: string
): Promise<{ check: (email: string) => boolean }> {
  const rows = await db
    .select({ email: agentGreylist.email })
    .from(agentGreylist)
    .where(and(eq(agentGreylist.agentId, agentId), eq(agentGreylist.workspaceId, workspaceId)));

  const emailSet = new Set(rows.map(r => r.email));

  return {
    check(email: string): boolean {
      return emailSet.has(email);
    },
  };
}

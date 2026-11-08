import { eq, and } from "drizzle-orm";
import { agentWhitelist, agent } from "../schema";
import type { Database } from "../index";
import { parseEmailHandle } from "../../utils/email";

export async function isWhitelisted(db: Database, agentId: string, workspaceId: string, email: string): Promise<boolean> {
  const handle = parseEmailHandle(email);
  if (handle) {
    const rows = await db
      .select({ workspaceId: agent.workspaceId })
      .from(agent)
      .where(eq(agent.emailHandle, handle))
      .limit(1);
    if (rows.length > 0 && rows[0].workspaceId === workspaceId) return true;
  }

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

export async function buildWhitelistSet(
  db: Database, agentId: string, workspaceId: string
): Promise<{ check: (email: string) => boolean }> {
  const [whitelistRows, agentRows] = await Promise.all([
    db.select({ email: agentWhitelist.email })
      .from(agentWhitelist)
      .where(and(eq(agentWhitelist.agentId, agentId), eq(agentWhitelist.workspaceId, workspaceId))),
    db.select({ emailHandle: agent.emailHandle })
      .from(agent)
      .where(eq(agent.workspaceId, workspaceId)),
  ]);

  const emailSet = new Set(whitelistRows.map(r => r.email));
  const handleSet = new Set(
    agentRows.filter(r => r.emailHandle).map(r => r.emailHandle!)
  );

  return {
    check(email: string): boolean {
      const handle = parseEmailHandle(email);
      if (handle && handleSet.has(handle)) return true;
      return emailSet.has(email);
    },
  };
}

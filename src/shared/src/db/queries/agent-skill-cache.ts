import { eq, and } from "drizzle-orm";
import { agentSkillCache } from "../schema";
import type { Database } from "../index";

export async function upsert(
  db: Database,
  data: {
    workspaceId: string;
    agentId: string;
    runtime: string;
    skills: string;
  },
) {
  const existing = await db
    .select()
    .from(agentSkillCache)
    .where(
      and(
        eq(agentSkillCache.agentId, data.agentId),
        eq(agentSkillCache.runtime, data.runtime),
      ),
    );

  if (existing.length > 0) {
    await db
      .update(agentSkillCache)
      .set({ skills: data.skills, syncedAt: new Date().toISOString() })
      .where(eq(agentSkillCache.id, existing[0]!.id));
    return existing[0]!;
  }

  const rows = await db
    .insert(agentSkillCache)
    .values({ ...data, syncedAt: new Date().toISOString() })
    .returning();
  return rows[0]!;
}

export async function getByAgentRuntime(
  db: Database,
  agentId: string,
  runtime: string,
) {
  const rows = await db
    .select()
    .from(agentSkillCache)
    .where(
      and(
        eq(agentSkillCache.agentId, agentId),
        eq(agentSkillCache.runtime, runtime),
      ),
    );
  return rows[0] ?? null;
}

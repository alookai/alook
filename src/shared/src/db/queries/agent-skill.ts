import { eq, and } from "drizzle-orm";
import { agentSkill } from "../schema";
import type { Database } from "../index";

interface SkillRow {
  name: string;
  description: string;
  scope: string;
}

export async function syncSkills(
  db: Database,
  agentId: string,
  runtime: string,
  workspaceId: string,
  skills: SkillRow[],
) {
  await db
    .delete(agentSkill)
    .where(and(eq(agentSkill.agentId, agentId), eq(agentSkill.runtime, runtime)));

  if (skills.length === 0) return;

  const now = new Date().toISOString();
  await db.insert(agentSkill).values(
    skills.map((s) => ({
      workspaceId,
      agentId,
      runtime,
      name: s.name,
      description: s.description,
      scope: s.scope,
      syncedAt: now,
    })),
  );
}

export async function getSkills(
  db: Database,
  agentId: string,
  runtime: string,
) {
  return db
    .select({
      name: agentSkill.name,
      description: agentSkill.description,
      scope: agentSkill.scope,
    })
    .from(agentSkill)
    .where(and(eq(agentSkill.agentId, agentId), eq(agentSkill.runtime, runtime)));
}

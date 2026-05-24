import { eq, and, isNull, or } from "drizzle-orm";
import { agentSkill } from "../schema";
import type { Database } from "../index";

interface SkillRow {
  name: string;
  description: string;
}

export async function syncGlobalSkills(
  db: Database,
  workspaceId: string,
  runtime: string,
  skills: SkillRow[],
) {
  const now = new Date().toISOString();
  const rows = skills.map((s) => ({
    workspaceId,
    agentId: null,
    runtime,
    name: s.name,
    description: s.description,
    syncedAt: now,
  }));

  const BATCH_SIZE = 10;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [
    db.delete(agentSkill).where(
      and(eq(agentSkill.workspaceId, workspaceId), eq(agentSkill.runtime, runtime), isNull(agentSkill.agentId))
    ),
  ];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    statements.push(db.insert(agentSkill).values(rows.slice(i, i + BATCH_SIZE)));
  }
  await db.batch(statements as [any, ...any[]]);
}

export async function syncAgentSkills(
  db: Database,
  agentId: string,
  runtime: string,
  workspaceId: string,
  skills: SkillRow[],
) {
  const now = new Date().toISOString();
  const rows = skills.map((s) => ({
    workspaceId,
    agentId,
    runtime,
    name: s.name,
    description: s.description,
    syncedAt: now,
  }));

  const BATCH_SIZE = 10;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [
    db.delete(agentSkill).where(
      and(eq(agentSkill.agentId, agentId), eq(agentSkill.runtime, runtime))
    ),
  ];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    statements.push(db.insert(agentSkill).values(rows.slice(i, i + BATCH_SIZE)));
  }
  await db.batch(statements as [any, ...any[]]);
}

export async function getSkills(
  db: Database,
  agentId: string,
  runtime: string,
  workspaceId: string,
) {
  return db
    .select({
      name: agentSkill.name,
      description: agentSkill.description,
      isGlobal: isNull(agentSkill.agentId),
    })
    .from(agentSkill)
    .where(
      and(
        eq(agentSkill.workspaceId, workspaceId),
        eq(agentSkill.runtime, runtime),
        or(isNull(agentSkill.agentId), eq(agentSkill.agentId, agentId))
      )
    );
}

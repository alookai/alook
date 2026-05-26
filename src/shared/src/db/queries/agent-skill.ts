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
  daemonId?: string,
) {
  const now = new Date().toISOString();
  const rows = skills.map((s) => ({
    workspaceId,
    agentId: null,
    daemonId: daemonId ?? null,
    runtime,
    name: s.name,
    description: s.description,
    syncedAt: now,
  }));

  const deleteCondition = daemonId
    ? and(eq(agentSkill.workspaceId, workspaceId), eq(agentSkill.runtime, runtime), isNull(agentSkill.agentId), eq(agentSkill.daemonId, daemonId))
    : and(eq(agentSkill.workspaceId, workspaceId), eq(agentSkill.runtime, runtime), isNull(agentSkill.agentId), isNull(agentSkill.daemonId));

  const BATCH_SIZE = 10;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [
    db.delete(agentSkill).where(deleteCondition),
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
  const rows = await db
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

  // Deduplicate global skills by name (multiple daemons may sync the same skill)
  const seen = new Set<string>();
  const deduped: typeof rows = [];
  for (const row of rows) {
    const key = row.isGlobal ? `global:${row.name}` : `agent:${row.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }
  return deduped;
}

import { eq, and, or, inArray } from "drizzle-orm";
import { agentLink, agent } from "../schema";
import type { Database } from "../index";

export async function listByWorkspace(
  db: Database,
  workspaceId: string,
  opts?: { limit?: number; offset?: number },
) {
  let q = db
    .select()
    .from(agentLink)
    .where(eq(agentLink.workspaceId, workspaceId))
    .$dynamic();
  if (opts?.limit) q = q.limit(opts.limit);
  if (opts?.offset) q = q.offset(opts.offset);
  return q;
}

export async function listByAgent(db: Database, agentId: string, workspaceId: string) {
  return db
    .select()
    .from(agentLink)
    .where(
      and(
        eq(agentLink.workspaceId, workspaceId),
        or(
          eq(agentLink.sourceAgentId, agentId),
          eq(agentLink.targetAgentId, agentId),
        ),
      ),
    );
}

export async function create(
  db: Database,
  data: {
    workspaceId: string;
    sourceAgentId: string;
    targetAgentId: string;
    instruction?: string;
  },
) {
  let { sourceAgentId, targetAgentId } = data;
  if (sourceAgentId > targetAgentId) {
    [sourceAgentId, targetAgentId] = [targetAgentId, sourceAgentId];
  }
  const rows = await db
    .insert(agentLink)
    .values({
      workspaceId: data.workspaceId,
      sourceAgentId,
      targetAgentId,
      instruction: data.instruction ?? "",
    })
    .returning();
  return rows[0]!;
}

export async function getByPair(
  db: Database,
  workspaceId: string,
  a: string,
  b: string,
) {
  const [sourceAgentId, targetAgentId] = a > b ? [b, a] : [a, b];
  const rows = await db
    .select()
    .from(agentLink)
    .where(
      and(
        eq(agentLink.workspaceId, workspaceId),
        eq(agentLink.sourceAgentId, sourceAgentId),
        eq(agentLink.targetAgentId, targetAgentId),
      ),
    );
  return rows[0] ?? null;
}

export async function upsertByPair(
  db: Database,
  data: {
    workspaceId: string;
    sourceAgentId: string;
    targetAgentId: string;
    instruction: string;
  },
) {
  const existing = await getByPair(
    db,
    data.workspaceId,
    data.sourceAgentId,
    data.targetAgentId,
  );
  if (existing) {
    const updated = await update(db, existing.id, data.workspaceId, {
      instruction: data.instruction,
    });
    if (!updated) return { row: existing, created: false };
    return { row: updated, created: false };
  }
  const created = await create(db, data);
  return { row: created, created: true };
}

export async function getById(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(agentLink)
    .where(and(eq(agentLink.id, id), eq(agentLink.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function update(
  db: Database,
  id: string,
  workspaceId: string,
  data: { instruction: string },
) {
  const rows = await db
    .update(agentLink)
    .set({
      instruction: data.instruction,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(agentLink.id, id), eq(agentLink.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function remove(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .delete(agentLink)
    .where(and(eq(agentLink.id, id), eq(agentLink.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function getColleaguesForAgent(
  db: Database,
  agentId: string,
  workspaceId: string,
) {
  const asSource = await db
    .select({
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.targetAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(
      and(
        eq(agentLink.sourceAgentId, agentId),
        eq(agentLink.workspaceId, workspaceId),
      ),
    );

  const asTarget = await db
    .select({
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.sourceAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(
      and(
        eq(agentLink.targetAgentId, agentId),
        eq(agentLink.workspaceId, workspaceId),
      ),
    );

  return [...asSource, ...asTarget];
}

export async function getColleaguesForAgents(
  db: Database,
  agentIds: string[],
  workspaceId: string,
) {
  if (agentIds.length === 0) return [];

  const asSource = await db
    .select({
      agentId: agentLink.sourceAgentId,
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.targetAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(
      and(
        inArray(agentLink.sourceAgentId, agentIds),
        eq(agentLink.workspaceId, workspaceId),
      ),
    );

  const asTarget = await db
    .select({
      agentId: agentLink.targetAgentId,
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.sourceAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(
      and(
        inArray(agentLink.targetAgentId, agentIds),
        eq(agentLink.workspaceId, workspaceId),
      ),
    );

  return [...asSource, ...asTarget];
}

export async function getAllColleaguesForWorkspace(
  db: Database,
  workspaceId: string,
) {
  const asSource = await db
    .select({
      agentId: agentLink.sourceAgentId,
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.targetAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(eq(agentLink.workspaceId, workspaceId));

  const asTarget = await db
    .select({
      agentId: agentLink.targetAgentId,
      name: agent.name,
      emailHandle: agent.emailHandle,
      description: agent.description,
      instruction: agentLink.instruction,
    })
    .from(agentLink)
    .innerJoin(
      agent,
      and(eq(agent.id, agentLink.sourceAgentId), eq(agent.workspaceId, agentLink.workspaceId)),
    )
    .where(eq(agentLink.workspaceId, workspaceId));

  return [...asSource, ...asTarget];
}

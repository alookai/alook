import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { agentRuntime, agent, machine } from "../schema";
import type { Database } from "../index";

export async function upsertAgentRuntime(
  db: Database,
  data: {
    workspaceId: string;
    daemonId: string;
    runtimeMode: string;
    provider: string;
    deviceInfo: string;
    metadata?: unknown;
  }
) {
  const now = new Date().toISOString();
  const metaJson = JSON.stringify(data.metadata ?? {});
  const rows = await db
    .insert(agentRuntime)
    .values({
      workspaceId: data.workspaceId,
      daemonId: data.daemonId,
      runtimeMode: data.runtimeMode,
      provider: data.provider,
      deviceInfo: data.deviceInfo,
      metadata: data.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: [
        agentRuntime.workspaceId,
        agentRuntime.daemonId,
        agentRuntime.provider,
      ],
      set: {
        runtimeMode: data.runtimeMode,
        deviceInfo: data.deviceInfo,
        metadata: sql`json_patch(coalesce(${agentRuntime.metadata}, '{}'), ${metaJson})`,
        updatedAt: now,
      },
    })
    .returning();
  return rows[0]!;
}

export async function listAgentRuntimes(db: Database, workspaceId: string) {
  return db
    .select({
      id: agentRuntime.id,
      workspaceId: agentRuntime.workspaceId,
      daemonId: agentRuntime.daemonId,
      runtimeMode: agentRuntime.runtimeMode,
      provider: agentRuntime.provider,
      deviceInfo: agentRuntime.deviceInfo,
      metadata: agentRuntime.metadata,
      createdAt: agentRuntime.createdAt,
      updatedAt: agentRuntime.updatedAt,
      machineLastSeenAt: machine.lastSeenAt,
      pendingUpdateVersion: machine.pendingUpdateVersion,
      pendingRescan: machine.pendingRescan,
    })
    .from(agentRuntime)
    .leftJoin(
      machine,
      and(
        eq(machine.daemonId, agentRuntime.daemonId),
        eq(machine.workspaceId, agentRuntime.workspaceId)
      )
    )
    .where(eq(agentRuntime.workspaceId, workspaceId))
    .orderBy(asc(agentRuntime.createdAt));
}

export async function getAgentRuntime(db: Database, id: string) {
  const rows = await db
    .select()
    .from(agentRuntime)
    .where(eq(agentRuntime.id, id));
  return rows[0] ?? null;
}

export async function getAgentRuntimeForWorkspace(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .select({
      id: agentRuntime.id,
      workspaceId: agentRuntime.workspaceId,
      daemonId: agentRuntime.daemonId,
      runtimeMode: agentRuntime.runtimeMode,
      provider: agentRuntime.provider,
      deviceInfo: agentRuntime.deviceInfo,
      metadata: agentRuntime.metadata,
      createdAt: agentRuntime.createdAt,
      updatedAt: agentRuntime.updatedAt,
      machineLastSeenAt: machine.lastSeenAt,
      pendingUpdateVersion: machine.pendingUpdateVersion,
      pendingRescan: machine.pendingRescan,
    })
    .from(agentRuntime)
    .leftJoin(
      machine,
      and(
        eq(machine.daemonId, agentRuntime.daemonId),
        eq(machine.workspaceId, agentRuntime.workspaceId)
      )
    )
    .where(
      and(eq(agentRuntime.id, id), eq(agentRuntime.workspaceId, workspaceId))
    );
  return rows[0] ?? null;
}

export async function getAgentRuntimesForWorkspace(
  db: Database,
  ids: string[],
  workspaceId: string
) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: agentRuntime.id,
      workspaceId: agentRuntime.workspaceId,
      daemonId: agentRuntime.daemonId,
      runtimeMode: agentRuntime.runtimeMode,
      provider: agentRuntime.provider,
      deviceInfo: agentRuntime.deviceInfo,
      metadata: agentRuntime.metadata,
      createdAt: agentRuntime.createdAt,
      updatedAt: agentRuntime.updatedAt,
      machineLastSeenAt: machine.lastSeenAt,
      pendingUpdateVersion: machine.pendingUpdateVersion,
      pendingRescan: machine.pendingRescan,
    })
    .from(agentRuntime)
    .leftJoin(
      machine,
      and(
        eq(machine.daemonId, agentRuntime.daemonId),
        eq(machine.workspaceId, agentRuntime.workspaceId)
      )
    )
    .where(
      and(inArray(agentRuntime.id, ids), eq(agentRuntime.workspaceId, workspaceId))
    );
}

export async function deleteRuntimesByDaemonId(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const runtimes = await db
    .select({ id: agentRuntime.id })
    .from(agentRuntime)
    .where(
      and(
        eq(agentRuntime.daemonId, daemonId),
        eq(agentRuntime.workspaceId, workspaceId)
      )
    );

  if (runtimes.length === 0) return;

  const runtimeIds = runtimes.map(r => r.id);
  await db
    .update(agent)
    .set({ runtimeId: null, updatedAt: new Date().toISOString() })
    .where(inArray(agent.runtimeId, runtimeIds));

  await db
    .delete(agentRuntime)
    .where(
      and(
        eq(agentRuntime.daemonId, daemonId),
        eq(agentRuntime.workspaceId, workspaceId)
      )
    );
}

export async function getRuntimeIdsByDaemon(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const rows = await db
    .select({ id: agentRuntime.id })
    .from(agentRuntime)
    .where(
      and(
        eq(agentRuntime.daemonId, daemonId),
        eq(agentRuntime.workspaceId, workspaceId)
      )
    );
  return rows.map((r) => r.id);
}

import { eq, and } from "drizzle-orm";
import { machine } from "../schema";
import type { Database } from "../index";

export async function upsertMachine(
  db: Database,
  data: {
    daemonId: string;
    workspaceId: string;
    deviceInfo: string;
    lastSeenAt?: string | null;
  }
) {
  const now = new Date().toISOString();
  const lastSeenAt = data.lastSeenAt === undefined ? now : data.lastSeenAt;
  const rows = await db
    .insert(machine)
    .values({
      daemonId: data.daemonId,
      workspaceId: data.workspaceId,
      deviceInfo: data.deviceInfo,
      lastSeenAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [machine.workspaceId, machine.daemonId],
      set: {
        deviceInfo: data.deviceInfo,
        lastSeenAt,
        updatedAt: now,
      },
    })
    .returning();
  return rows[0]!;
}

export async function updateMachineLastSeen(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
}

export async function setMachineLastSeenNull(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ lastSeenAt: null, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
}

export async function getMachineByDaemon(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(machine)
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
  return rows[0] ?? null;
}

export async function listMachinesForWorkspace(
  db: Database,
  workspaceId: string
) {
  return db
    .select()
    .from(machine)
    .where(eq(machine.workspaceId, workspaceId));
}

export async function deleteMachine(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  await db
    .delete(machine)
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
}

export async function setPendingUpdateVersion(
  db: Database,
  daemonId: string,
  workspaceId: string,
  version: string
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ pendingUpdateVersion: version, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
}

export async function clearPendingUpdateVersion(
  db: Database,
  daemonId: string,
  workspaceId: string
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ pendingUpdateVersion: null, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId))
    );
}

export async function setPendingRescan(
  db: Database,
  daemonId: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ pendingRescan: true, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId)),
    );
}

export async function clearPendingRescan(
  db: Database,
  daemonId: string,
  workspaceId: string,
) {
  const now = new Date().toISOString();
  await db
    .update(machine)
    .set({ pendingRescan: false, updatedAt: now })
    .where(
      and(eq(machine.daemonId, daemonId), eq(machine.workspaceId, workspaceId)),
    );
}

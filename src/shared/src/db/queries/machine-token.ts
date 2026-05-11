import { eq, and, desc, isNull } from "drizzle-orm";
import { machineToken, user } from "../schema";
import type { Database } from "../index";

export async function createMachineToken(
  db: Database,
  data: {
    userId: string;
    workspaceId?: string | null;
    token: string;
    name: string;
    status?: string;
  }
) {
  const rows = await db
    .insert(machineToken)
    .values({
      userId: data.userId,
      workspaceId: data.workspaceId ?? null,
      token: data.token,
      name: data.name,
      status: data.status ?? "active",
    })
    .returning();
  return rows[0]!;
}

export async function getMachineTokenByToken(db: Database, token: string) {
  const rows = await db
    .select({
      id: machineToken.id,
      userId: machineToken.userId,
      workspaceId: machineToken.workspaceId,
      token: machineToken.token,
      name: machineToken.name,
      status: machineToken.status,
      lastUsedAt: machineToken.lastUsedAt,
      createdAt: machineToken.createdAt,
      userEmail: user.email,
    })
    .from(machineToken)
    .innerJoin(user, eq(user.id, machineToken.userId))
    .where(eq(machineToken.token, token));
  return rows[0] ?? null;
}

export async function getPendingMachineToken(
  db: Database,
  userId: string,
  workspaceId?: string | null
) {
  const conditions = [
    eq(machineToken.userId, userId),
    eq(machineToken.status, "pending"),
  ];
  if (workspaceId) {
    conditions.push(eq(machineToken.workspaceId, workspaceId));
  } else {
    conditions.push(isNull(machineToken.workspaceId));
  }
  const rows = await db
    .select()
    .from(machineToken)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

export async function activateMachineToken(db: Database, id: string, workspaceId?: string) {
  await db
    .update(machineToken)
    .set({ status: "active", ...(workspaceId ? { workspaceId } : {}) })
    .where(eq(machineToken.id, id));
}

export async function listMachineTokens(
  db: Database,
  userId: string,
  workspaceId: string
) {
  return db
    .select()
    .from(machineToken)
    .where(
      and(
        eq(machineToken.userId, userId),
        eq(machineToken.workspaceId, workspaceId)
      )
    )
    .orderBy(desc(machineToken.createdAt));
}

export async function deleteMachineToken(
  db: Database,
  id: string,
  userId: string
) {
  await db
    .delete(machineToken)
    .where(and(eq(machineToken.id, id), eq(machineToken.userId, userId)));
}

export async function updateMachineTokenLastUsed(db: Database, id: string) {
  await db
    .update(machineToken)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(machineToken.id, id));
}

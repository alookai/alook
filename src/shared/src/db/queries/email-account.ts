import { eq, and, inArray } from "drizzle-orm";
import { agentEmailAccount } from "../schema";
import type { Database } from "../index";

export async function createEmailAccount(
  db: Database,
  data: {
    agentId: string;
    workspaceId: string;
    emailAddress: string;
    displayName?: string;
    imapHost: string;
    imapPort?: number;
    imapUsername: string;
    imapPassword: string;
    imapTls?: boolean;
    smtpHost: string;
    smtpPort?: number;
    smtpUsername: string;
    smtpPassword: string;
    smtpTls?: number;
    pollIntervalSeconds?: number;
  }
) {
  const rows = await db.insert(agentEmailAccount).values(data).returning();
  return rows[0]!;
}

export async function getEmailAccount(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(agentEmailAccount)
    .where(and(eq(agentEmailAccount.id, id), eq(agentEmailAccount.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function getEmailAccountScoped(db: Database, id: string, agentId: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(agentEmailAccount)
    .where(and(
      eq(agentEmailAccount.id, id),
      eq(agentEmailAccount.agentId, agentId),
      eq(agentEmailAccount.workspaceId, workspaceId),
    ));
  return rows[0] ?? null;
}

export async function getEmailAccountById(db: Database, id: string) {
  const rows = await db
    .select()
    .from(agentEmailAccount)
    .where(eq(agentEmailAccount.id, id));
  return rows[0] ?? null;
}

export async function getEmailAccountsByAgent(db: Database, agentId: string, workspaceId: string) {
  return db
    .select()
    .from(agentEmailAccount)
    .where(and(eq(agentEmailAccount.agentId, agentId), eq(agentEmailAccount.workspaceId, workspaceId)));
}

export async function updateEmailAccount(
  db: Database,
  id: string,
  workspaceId: string,
  data: Partial<{
    emailAddress: string;
    displayName: string;
    imapHost: string;
    imapPort: number;
    imapUsername: string;
    imapPassword: string;
    imapTls: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUsername: string;
    smtpPassword: string;
    smtpTls: number;
    pollIntervalSeconds: number;
    lastSyncedUid: string;
    lastSyncedAt: string | null;
    status: string;
    errorMessage: string;
  }>
) {
  const rows = await db
    .update(agentEmailAccount)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(agentEmailAccount.id, id), eq(agentEmailAccount.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteEmailAccount(db: Database, id: string, workspaceId: string) {
  const rows = await db
    .delete(agentEmailAccount)
    .where(and(eq(agentEmailAccount.id, id), eq(agentEmailAccount.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function getEmailAccountsByAgents(db: Database, agentIds: string[], workspaceId: string) {
  if (agentIds.length === 0) return [];
  return db
    .select()
    .from(agentEmailAccount)
    .where(and(inArray(agentEmailAccount.agentId, agentIds), eq(agentEmailAccount.workspaceId, workspaceId)));
}

export async function getAllEmailAccountsForWorkspace(db: Database, workspaceId: string) {
  return db
    .select()
    .from(agentEmailAccount)
    .where(eq(agentEmailAccount.workspaceId, workspaceId));
}

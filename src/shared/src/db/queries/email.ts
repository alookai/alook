import { eq, desc, inArray, and } from "drizzle-orm";
import { emails } from "../schema";
import type { Database } from "../index";

export async function createEmail(
  db: Database,
  data: { agentId: string; fromEmail: string; toEmail: string; subject: string; r2Key: string; isWhitelisted: boolean; forwarded: boolean; htmlBody?: string; attachments?: string }
) {
  const rows = await db.insert(emails).values(data).returning();
  return rows[0]!;
}

export async function getEmailById(db: Database, id: string) {
  const rows = await db.select().from(emails).where(eq(emails.id, id));
  return rows[0] ?? null;
}

export async function getEmailsByAgent(db: Database, agentId: string) {
  return db.select().from(emails).where(eq(emails.agentId, agentId)).orderBy(desc(emails.createdAt));
}

export async function getInboxEmails(db: Database, agentId: string, agentEmail: string) {
  return db.select().from(emails)
    .where(and(eq(emails.agentId, agentId), eq(emails.toEmail, agentEmail)))
    .orderBy(desc(emails.createdAt));
}

export async function getSentEmails(db: Database, agentId: string, agentEmail: string) {
  return db.select().from(emails)
    .where(and(eq(emails.agentId, agentId), eq(emails.fromEmail, agentEmail)))
    .orderBy(desc(emails.createdAt));
}

export async function getEmailsByUser(db: Database, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  return db.select().from(emails).where(inArray(emails.agentId, agentIds)).orderBy(desc(emails.createdAt));
}

export async function deleteEmail(db: Database, id: string) {
  return db.delete(emails).where(eq(emails.id, id));
}

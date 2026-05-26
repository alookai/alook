import { eq, desc, and, or, lt } from "drizzle-orm";
import { emails } from "../schema";
import type { Database } from "../index";
import type { EmailDirection } from "../../types";
import { EmailMailbox } from "../../constants";
import type { EmailMailboxType } from "../../constants";
import { getMailboxAddressFields } from "../../lib/email-mailbox";

type EmailInsert = Parameters<typeof createEmail>[1];

export type PromoteInboundWithDraftReplyResult =
  | { applied: true; draftEmailId: string }
  | { applied: false; cleanupError?: string };

export interface EmailPagination {
  limit: number;
  offset: number;
}

export interface EmailMailboxFilters {
  status?: string;
  pagination?: EmailPagination;
  address?: string;
}

export async function createEmail(
  db: Database,
  data: { agentId: string; workspaceId: string; fromEmail: string; toEmail: string; subject: string; r2Key: string; isWhitelisted: boolean; forwarded: boolean; direction: EmailDirection; messageId?: string; inReplyTo?: string; references?: string; htmlBody?: string; attachments?: string; status?: string; mailbox?: EmailMailboxType }
) {
  const rows = await db.insert(emails).values(data).returning();
  return rows[0]!;
}

export async function getEmailById(db: Database, id: string, workspaceId: string) {
  const rows = await db.select().from(emails).where(and(eq(emails.id, id), eq(emails.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function getInboundDraftEmailForAgent(
  db: Database,
  input: {
    inboundEmailId: string;
    agentId: string;
    workspaceId: string;
  },
) {
  const rows = await db
    .select()
    .from(emails)
    .where(and(
      eq(emails.id, input.inboundEmailId),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "inbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
    ));
  return rows[0] ?? null;
}

export async function getEmailsByAgent(db: Database, agentId: string, workspaceId: string, status?: string, pagination?: EmailPagination) {
  const conditions = [eq(emails.agentId, agentId), eq(emails.workspaceId, workspaceId)];
  if (status) conditions.push(eq(emails.status, status));
  const q = db
    .select()
    .from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (pagination) return q.limit(pagination.limit).offset(pagination.offset);
  return q;
}

export async function getInboxEmails(db: Database, agentId: string, agentEmail: string, workspaceId: string, status?: string, pagination?: EmailPagination) {
  const conditions = [eq(emails.agentId, agentId), eq(emails.toEmail, agentEmail), eq(emails.workspaceId, workspaceId), eq(emails.direction, "inbound")];
  if (status) conditions.push(eq(emails.status, status));
  const q = db.select().from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (pagination) return q.limit(pagination.limit).offset(pagination.offset);
  return q;
}

export async function getSentEmails(db: Database, agentId: string, agentEmail: string, workspaceId: string, status?: string, pagination?: EmailPagination) {
  const conditions = [eq(emails.agentId, agentId), eq(emails.fromEmail, agentEmail), eq(emails.workspaceId, workspaceId), eq(emails.direction, "outbound")];
  if (status) conditions.push(eq(emails.status, status));
  const q = db.select().from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (pagination) return q.limit(pagination.limit).offset(pagination.offset);
  return q;
}

export async function getTrustedEmails(db: Database, agentId: string, agentEmail: string, workspaceId: string, status?: string, pagination?: EmailPagination) {
  const conditions = [eq(emails.agentId, agentId), eq(emails.toEmail, agentEmail), eq(emails.workspaceId, workspaceId), eq(emails.isWhitelisted, true), eq(emails.direction, "inbound")];
  if (status) conditions.push(eq(emails.status, status));
  const q = db.select().from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (pagination) return q.limit(pagination.limit).offset(pagination.offset);
  return q;
}

export async function getRejectedEmails(db: Database, agentId: string, agentEmail: string, workspaceId: string, status?: string, pagination?: EmailPagination) {
  const conditions = [eq(emails.agentId, agentId), eq(emails.toEmail, agentEmail), eq(emails.workspaceId, workspaceId), eq(emails.isWhitelisted, false), eq(emails.direction, "inbound")];
  if (status) conditions.push(eq(emails.status, status));
  const q = db.select().from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (pagination) return q.limit(pagination.limit).offset(pagination.offset);
  return q;
}

export async function getEmailsByMailbox(
  db: Database,
  agentId: string,
  workspaceId: string,
  mailbox: EmailMailboxType,
  filters: EmailMailboxFilters = {}
) {
  const conditions = [
    eq(emails.agentId, agentId),
    eq(emails.workspaceId, workspaceId),
    eq(emails.mailbox, mailbox),
  ];
  if (filters.status) conditions.push(eq(emails.status, filters.status));
  if (filters.address) {
    const addressFields = getMailboxAddressFields(mailbox);
    if (addressFields.length === 2) {
      conditions.push(or(eq(emails.toEmail, filters.address), eq(emails.fromEmail, filters.address))!);
    } else if (addressFields[0] === "fromEmail") {
      conditions.push(eq(emails.fromEmail, filters.address));
    } else {
      conditions.push(eq(emails.toEmail, filters.address));
    }
  }
  const q = db.select().from(emails)
    .where(and(...conditions))
    .orderBy(desc(emails.createdAt));
  if (filters.pagination) return q.limit(filters.pagination.limit).offset(filters.pagination.offset);
  return q;
}

export async function getEmailByMessageId(db: Database, messageId: string, workspaceId: string) {
  if (!messageId) return null;
  const rows = await db.select().from(emails).where(and(eq(emails.messageId, messageId), eq(emails.workspaceId, workspaceId)));
  return rows[0] ?? null;
}

export async function updateEmailStatus(db: Database, id: string, workspaceId: string, status: string) {
  const rows = await db.update(emails).set({ status }).where(and(eq(emails.id, id), eq(emails.workspaceId, workspaceId))).returning();
  return rows[0] ?? null;
}

export async function updateEmailMailbox(
  db: Database,
  id: string,
  workspaceId: string,
  mailbox: EmailMailboxType,
  extra?: { status?: string }
) {
  const rows = await db
    .update(emails)
    .set({ mailbox, ...(extra?.status ? { status: extra.status } : {}) })
    .where(and(eq(emails.id, id), eq(emails.workspaceId, workspaceId)))
    .returning();
  return rows[0] ?? null;
}

export async function archiveInboundDraftAsUntrust(
  db: Database,
  input: {
    inboundEmailId: string;
    agentId: string;
    workspaceId: string;
  },
) {
  const rows = await db
    .update(emails)
    .set({ mailbox: EmailMailbox.UNTRUST, status: "archived" })
    .where(and(
      eq(emails.id, input.inboundEmailId),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "inbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
    ))
    .returning();
  return rows[0] ?? null;
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupDraft(
  db: Database,
  draftId: string,
  workspaceId: string,
): Promise<{ cleanupError?: string }> {
  try {
    await deleteEmail(db, draftId, workspaceId);
    return {};
  } catch (error) {
    return { cleanupError: cleanupErrorMessage(error) };
  }
}

export async function promoteInboundWithDraftReply(
  db: Database,
  input: {
    inboundEmailId: string;
    agentId: string;
    workspaceId: string;
    draft: {
      fromEmail: string;
      toEmail: string;
      subject: string;
      htmlBody: string;
      inReplyTo: string;
      references: string;
    };
  },
): Promise<PromoteInboundWithDraftReplyResult> {
  const inbound = await getInboundDraftEmailForAgent(db, input);
  if (!inbound) return { applied: false };

  let claimedRows: unknown[];
  try {
    claimedRows = await db
      .update(emails)
      .set({ status: "triage_applying" })
      .where(and(
        eq(emails.id, input.inboundEmailId),
        eq(emails.agentId, input.agentId),
        eq(emails.workspaceId, input.workspaceId),
        eq(emails.direction, "inbound"),
        eq(emails.mailbox, EmailMailbox.DRAFT),
      ))
      .returning();
  } catch {
    return { applied: false };
  }
  if (!claimedRows[0]) return { applied: false };

  const draftValues: EmailInsert = {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    fromEmail: input.draft.fromEmail,
    toEmail: input.draft.toEmail,
    subject: input.draft.subject,
    r2Key: "",
    isWhitelisted: false,
    forwarded: false,
    messageId: "",
    inReplyTo: input.draft.inReplyTo,
    references: input.draft.references,
    htmlBody: input.draft.htmlBody,
    attachments: "[]",
    direction: "outbound",
    status: "triage_applying",
    mailbox: EmailMailbox.DRAFT,
  };

  let draft: { id: string };
  try {
    const draftRows = await db.insert(emails).values(draftValues).returning();
    if (!draftRows[0]) {
      await restoreInboundDraftAfterTriageApplyFailure(db, input, inbound.status);
      return { applied: false };
    }
    draft = draftRows[0];
  } catch {
    await restoreInboundDraftAfterTriageApplyFailure(db, input, inbound.status);
    return { applied: false };
  }

  let promoted: unknown;
  try {
    const promotedRows = await db
      .update(emails)
      .set({ mailbox: EmailMailbox.INBOX, status: "unread" })
      .where(and(
        eq(emails.id, input.inboundEmailId),
        eq(emails.agentId, input.agentId),
        eq(emails.workspaceId, input.workspaceId),
        eq(emails.direction, "inbound"),
        eq(emails.mailbox, EmailMailbox.DRAFT),
        eq(emails.status, "triage_applying"),
      ))
      .returning();
    promoted = promotedRows[0];
  } catch {
    const cleanup = await cleanupDraft(db, draft.id, input.workspaceId);
    await restoreInboundDraftAfterTriageApplyFailure(db, input, inbound.status);
    return cleanup.cleanupError
      ? { applied: false, cleanupError: cleanup.cleanupError }
      : { applied: false };
  }

  if (!promoted) {
    const cleanup = await cleanupDraft(db, draft.id, input.workspaceId);
    await restoreInboundDraftAfterTriageApplyFailure(db, input, inbound.status);
    return cleanup.cleanupError
      ? { applied: false, cleanupError: cleanup.cleanupError }
      : { applied: false };
  }

  const finalizedDraftRows = await db
    .update(emails)
    .set({ status: "draft" })
    .where(and(
      eq(emails.id, draft.id),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "triage_applying"),
    ))
    .returning();
  if (!finalizedDraftRows[0]) {
    const cleanup = await cleanupDraft(db, draft.id, input.workspaceId);
    await restoreInboundDraftAfterTriageApplyFailure(db, input, inbound.status);
    return cleanup.cleanupError
      ? { applied: false, cleanupError: cleanup.cleanupError }
      : { applied: false };
  }

  return { applied: true, draftEmailId: draft.id };
}

export async function recoverStaleEmailTriageApplies(
  db: Database,
  workspaceId: string,
  staleSeconds = 3600,
) {
  const threshold = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const restoredInbound = await db
    .update(emails)
    .set({ mailbox: EmailMailbox.DRAFT, status: "unread" })
    .where(and(
      eq(emails.workspaceId, workspaceId),
      eq(emails.direction, "inbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "triage_applying"),
      lt(emails.createdAt, threshold),
    ))
    .returning({ id: emails.id });

  const deletedDrafts = await db
    .delete(emails)
    .where(and(
      eq(emails.workspaceId, workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "triage_applying"),
      lt(emails.createdAt, threshold),
    ))
    .returning({ id: emails.id });

  return {
    restoredInbound: restoredInbound.length,
    deletedDrafts: deletedDrafts.length,
  };
}

async function restoreInboundDraftAfterTriageApplyFailure(
  db: Database,
  input: {
    inboundEmailId: string;
    agentId: string;
    workspaceId: string;
  },
  status: string,
) {
  await db
    .update(emails)
    .set({ mailbox: EmailMailbox.DRAFT, status })
    .where(and(
      eq(emails.id, input.inboundEmailId),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "inbound"),
      eq(emails.status, "triage_applying"),
    ))
    .returning()
    .catch(() => {});
}

export async function claimDraftForSend(
  db: Database,
  input: {
    id: string;
    agentId: string;
    workspaceId: string;
  }
) {
  const rows = await db
    .update(emails)
    .set({ status: "sending" })
    .where(and(
      eq(emails.id, input.id),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "draft"),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function finalizeDraftSend(
  db: Database,
  input: {
    id: string;
    agentId: string;
    workspaceId: string;
    patch: {
      r2Key: string;
      messageId: string;
      inReplyTo: string;
      references: string;
      htmlBody: string;
      attachments: string;
      status: string;
      mailbox: EmailMailboxType;
    };
  }
) {
  const rows = await db
    .update(emails)
    .set(input.patch)
    .where(and(
      eq(emails.id, input.id),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "sending"),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function restoreDraftAfterSendFailure(
  db: Database,
  input: {
    id: string;
    agentId: string;
    workspaceId: string;
  }
) {
  const rows = await db
    .update(emails)
    .set({ status: "draft" })
    .where(and(
      eq(emails.id, input.id),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "sending"),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function markDraftSendUnknown(
  db: Database,
  input: {
    id: string;
    agentId: string;
    workspaceId: string;
  }
) {
  const rows = await db
    .update(emails)
    .set({ status: "send_unknown" })
    .where(and(
      eq(emails.id, input.id),
      eq(emails.agentId, input.agentId),
      eq(emails.workspaceId, input.workspaceId),
      eq(emails.direction, "outbound"),
      eq(emails.mailbox, EmailMailbox.DRAFT),
      eq(emails.status, "sending"),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function deleteEmail(db: Database, id: string, workspaceId: string) {
  return db.delete(emails).where(and(eq(emails.id, id), eq(emails.workspaceId, workspaceId)));
}

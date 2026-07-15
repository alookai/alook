import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { communityAttachment } from "../../community-schema";
import type { Database } from "../../index";

export type AttachmentKind = "channel" | "dm";

/**
 * Insert an attachment row already tied to a message (human-composer path).
 * The agent-attachment pipeline uses `createPendingAttachment` /
 * `reserveAttachmentsForMessage` instead — those two are the only writers of
 * `messageId = NULL` rows.
 */
export async function createAttachment(
  db: Database,
  data: {
    messageId: string;
    uploaderId: string;
    kind: AttachmentKind;
    targetId: string;
    r2Key: string;
    filename: string;
    position?: number;
    contentType?: string | null;
    size?: number | null;
    width?: number | null;
    height?: number | null;
  }
) {
  const [row] = await db
    .insert(communityAttachment)
    .values({
      messageId: data.messageId,
      uploaderId: data.uploaderId,
      kind: data.kind,
      targetId: data.targetId,
      r2Key: data.r2Key,
      filename: data.filename,
      position: data.position ?? null,
      contentType: data.contentType ?? null,
      size: data.size ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
    })
    .returning();
  return row!;
}

/**
 * Insert a pending attachment row (`messageId = NULL`) for the agent
 * `attachment upload` command. The caller receives the id and later passes
 * it to `send`, at which point `reserveAttachmentsForMessage` sets
 * `messageId` and `position`.
 */
export async function createPendingAttachment(
  db: Database,
  data: {
    id?: string;
    uploaderId: string;
    kind: AttachmentKind;
    targetId: string;
    r2Key: string;
    filename: string;
    contentType?: string | null;
    size?: number | null;
    width?: number | null;
    height?: number | null;
  }
) {
  const [row] = await db
    .insert(communityAttachment)
    .values({
      id: data.id ?? nanoid(),
      messageId: null,
      uploaderId: data.uploaderId,
      kind: data.kind,
      targetId: data.targetId,
      r2Key: data.r2Key,
      filename: data.filename,
      position: null,
      contentType: data.contentType ?? null,
      size: data.size ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
    })
    .returning();
  return row!;
}

/**
 * Send-time validation query: return the pending attachment rows that match
 * the (uploader, scope) tuple. Callers compare `rows.length === ids.length`
 * to detect any mismatch and reject with a generic 400 that never leaks
 * which specific id failed (avoids id enumeration).
 */
export async function findPendingAttachmentsForBot(
  db: Database,
  data: { ids: string[]; uploaderId: string; kind: AttachmentKind; targetId: string }
) {
  if (data.ids.length === 0) return [];
  return db
    .select()
    .from(communityAttachment)
    .where(
      and(
        inArray(communityAttachment.id, data.ids),
        isNull(communityAttachment.messageId),
        eq(communityAttachment.uploaderId, data.uploaderId),
        eq(communityAttachment.kind, data.kind),
        eq(communityAttachment.targetId, data.targetId)
      )
    );
}

/**
 * Reserve pending attachments for a pre-minted message id and stamp
 * `position` in the caller-specified order (`ids[0]` → position 0). Single
 * atomic UPDATE — a partial N-1 success on a per-row loop would leave
 * inconsistent state no single rowsAffected check could detect. The CAS
 * `messageId IS NULL` gate is the race guard: only rows we win the race for
 * are updated. Returns the ids that were actually reserved so the caller
 * can compare `returning.length === ids.length` to detect a race-loss.
 */
export async function reserveAttachmentsForMessage(
  db: Database,
  data: { ids: string[]; messageId: string }
): Promise<string[]> {
  if (data.ids.length === 0) return [];

  // Build `position = CASE id WHEN ids[0] THEN 0 WHEN ids[1] THEN 1 ... END`.
  // No ORM equivalent; hand-rolled `sql` template is the only viable path.
  const chunks = data.ids.map(
    (id, idx) => sql`WHEN ${id} THEN ${idx}`
  );
  const positionCase = sql.join(
    [sql`CASE ${communityAttachment.id}`, ...chunks, sql`END`],
    sql` `
  );

  const rows = await db
    .update(communityAttachment)
    .set({ messageId: data.messageId, position: positionCase })
    .where(
      and(
        inArray(communityAttachment.id, data.ids),
        isNull(communityAttachment.messageId)
      )
    )
    .returning({ id: communityAttachment.id });
  return rows.map((r) => r.id);
}

/**
 * Compensating UPDATE for the three send-time rollback sites:
 *   (a) reservation-mismatch (partial-overlap race),
 *   (b) `insertMessageRow` thrown exception,
 *   (c) `expectedSeq` CAS-null branch.
 * Scoped by `messageId = ?` so it only ever touches rows this caller reserved
 * with the same pre-minted id.
 */
export async function unreserveAttachments(
  db: Database,
  data: { ids: string[]; messageId: string }
) {
  if (data.ids.length === 0) return;
  await db
    .update(communityAttachment)
    .set({ messageId: null, position: null })
    .where(
      and(
        inArray(communityAttachment.id, data.ids),
        eq(communityAttachment.messageId, data.messageId)
      )
    );
}

/** Row-by-id lookup for the download route. May return a pending row. */
export async function getAttachmentById(db: Database, id: string) {
  const rows = await db
    .select()
    .from(communityAttachment)
    .where(eq(communityAttachment.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessageAttachments(
  db: Database,
  messageId: string
) {
  return db
    .select()
    .from(communityAttachment)
    .where(eq(communityAttachment.messageId, messageId))
    .orderBy(asc(communityAttachment.position), asc(communityAttachment.createdAt));
}

export async function listByMessageIds(
  db: Database,
  messageIds: string[]
) {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(communityAttachment)
    .where(inArray(communityAttachment.messageId, messageIds))
    .orderBy(asc(communityAttachment.position), asc(communityAttachment.createdAt));
}

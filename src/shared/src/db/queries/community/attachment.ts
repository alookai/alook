import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import { communityAttachment, communityChannel } from "../../community-schema";
import type { Database } from "../../index";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

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
    targetId: string;
    r2Key: string;
    thumbnailR2Key?: string | null;
    filename: string;
    contentType?: string | null;
    size?: number | null;
    width?: number | null;
    height?: number | null;
  }
) {
  const id = data.id ?? nanoid();
  const createdAt = new Date().toISOString();
  const candidate = db
    .select({
      id: sql<string>`${id}`.as("id"),
      messageId: sql<string | null>`NULL`.as("message_id"),
      uploaderId: sql<string>`${data.uploaderId}`.as("uploader_id"),
      targetId: communityChannel.id,
      r2Key: sql<string>`${data.r2Key}`.as("r2_key"),
      thumbnailR2Key: sql<string | null>`${data.thumbnailR2Key ?? null}`.as("thumbnail_r2_key"),
      filename: sql<string>`${data.filename}`.as("filename"),
      contentType: sql<string | null>`${data.contentType ?? null}`.as("content_type"),
      size: sql<number | null>`${data.size ?? null}`.as("size"),
      width: sql<number | null>`${data.width ?? null}`.as("width"),
      height: sql<number | null>`${data.height ?? null}`.as("height"),
      position: sql<number | null>`NULL`.as("position"),
      createdAt: sql<string>`${createdAt}`.as("created_at"),
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, data.targetId))
    .limit(1);

  const [row] = await db
    .insert(communityAttachment)
    .select(candidate)
    .returning();
  if (!row) throw new Error("attachment target no longer exists");
  return row;
}

/**
 * Send-time validation query: return the pending attachment rows that match
 * the (uploader, scope) tuple. Callers compare `rows.length === ids.length`
 * to detect any mismatch and reject with a generic 400 that never leaks
 * which specific id failed (avoids id enumeration).
 *
 * Actor-agnostic: the guarantee is keyed entirely on the `uploaderId` param, so
 * BOTH the human web composer and the bot flow use it (route/disc step 2b
 * unified them onto reserve-by-id). A caller passes its own credential user id;
 * the `uploaderId` + `messageId IS NULL` filters make it confused-deputy-safe —
 * a caller can only reserve pending rows it uploaded, into the target it
 * uploaded them for (the send-side dual of the download door's
 * authorize-from-row guard). Named "…ForSender" (not "…ForBot") because the
 * sender is whichever actor's credential keys the lookup.
 */
export async function findPendingAttachmentsForSender(
  db: Database,
  data: { ids: string[]; uploaderId: string; targetId: string }
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

export async function rebindPendingAttachmentsToChild(
  db: Database,
  data: { ids: string[]; uploaderId: string; parentTargetId: string; childTargetId: string }
): Promise<boolean> {
  if (data.ids.length === 0) return true;
  const eligible = alias(communityAttachment, "eligible_attachment");
  const eligibleCount = db
    .select({ value: count() })
    .from(eligible)
    .where(and(
      inArray(eligible.id, data.ids),
      isNull(eligible.messageId),
      eq(eligible.uploaderId, data.uploaderId),
      inArray(eligible.targetId, [data.parentTargetId, data.childTargetId])
    ));
  const rebound = await db
    .update(communityAttachment)
    .set({ targetId: data.childTargetId })
    .where(and(
      inArray(communityAttachment.id, data.ids),
      isNull(communityAttachment.messageId),
      eq(communityAttachment.uploaderId, data.uploaderId),
      inArray(communityAttachment.targetId, [data.parentTargetId, data.childTargetId]),
      sql`(${eligibleCount}) = ${data.ids.length}`
    ))
    .returning({ id: communityAttachment.id });
  return rebound.length === data.ids.length;
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
  // Live risk: inboxPull passes a page of up to 200 message ids (> 100). Chunk
  // the `inArray` for D1's 100-param limit, concat, then re-sort globally by
  // (position, createdAt) — both keys are in the projection, so per-chunk order
  // alone would be wrong across chunks.
  const rows = (
    await Promise.all(
      chunk(messageIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select()
          .from(communityAttachment)
          .where(inArray(communityAttachment.messageId, ids))
          .orderBy(asc(communityAttachment.position), asc(communityAttachment.createdAt))
      )
    )
  ).flat();
  rows.sort((a, b) =>
    a.position !== b.position
      ? (a.position ?? 0) - (b.position ?? 0)
      : a.createdAt < b.createdAt
        ? -1
        : a.createdAt > b.createdAt
          ? 1
          : 0
  );
  return rows;
}

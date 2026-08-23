import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  communityAttachment,
  communityChannel,
  communityMessage,
  communityReadState,
} from "../../community-schema";
import type { Database } from "../../index";

export type DeleteForumPostInput = {
  openerId: string;
  openerSeq: number;
  forumChannelId: string;
  childChannelId: string;
};

export type DeleteForumPostResult = {
  /** False only when a concurrently-resolved delete committed first. */
  deleted: boolean;
  /** Captured in the same D1 batch before message/channel cascades ran. */
  mediaKeys: string[];
};

/**
 * Delete one already-authorized canonical forum post as a single D1 unit.
 *
 * The route resolves and authorizes the exact opener→forum→unique-child tuple;
 * this primitive owns only mutation atomicity. It intentionally does not reuse
 * `hardDeleteMessage`, whose bookkeeping and contract are limited to immediate
 * send rollback.
 *
 * Batch order matters:
 *   1. snapshot every linked/pending Community-media key;
 *   2. repair or remove parent-forum read cursors that point at the opener;
 *   3. remove child-scoped pending attachment rows (linked rows cascade);
 *   4. update parent forum count/activity once;
 *   5. delete the opener, whose FK cascades the child channel and its rows.
 *
 * Every mutating statement is guarded by the opener still existing in the
 * resolved forum. D1 serializes each batch transaction, so when two requests
 * resolve before either commits, the loser becomes a no-op rather than
 * decrementing the parent twice.
 */
export async function deleteForumPost(
  db: Database,
  input: DeleteForumPostInput,
): Promise<DeleteForumPostResult> {
  const openerStillExists = sql<boolean>`EXISTS (
    SELECT 1 FROM community_message AS guarded_opener
    WHERE guarded_opener.id = ${input.openerId}
      AND guarded_opener.channel_id = ${input.forumChannelId}
  )`;
  const priorMessageExists = sql<boolean>`EXISTS (
    SELECT 1 FROM community_message AS prior_message
    WHERE prior_message.channel_id = ${input.forumChannelId}
      AND prior_message.seq < ${input.openerSeq}
  )`;
  // Drizzle has no scalar-subquery setter that can project three columns from
  // the same ordered prior row. Keep the three SQL expressions adjacent and
  // identical in scope/order so the read-state invariant is explicit.
  const priorId = sql<string>`(
    SELECT prior_message.id FROM community_message AS prior_message
    WHERE prior_message.channel_id = ${input.forumChannelId}
      AND prior_message.seq < ${input.openerSeq}
    ORDER BY prior_message.seq DESC LIMIT 1
  )`;
  const priorSeq = sql<number>`(
    SELECT prior_message.seq FROM community_message AS prior_message
    WHERE prior_message.channel_id = ${input.forumChannelId}
      AND prior_message.seq < ${input.openerSeq}
    ORDER BY prior_message.seq DESC LIMIT 1
  )`;
  const priorCreatedAt = sql<string>`(
    SELECT prior_message.created_at FROM community_message AS prior_message
    WHERE prior_message.channel_id = ${input.forumChannelId}
      AND prior_message.seq < ${input.openerSeq}
    ORDER BY prior_message.seq DESC LIMIT 1
  )`;

  const childMessageIds = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(eq(communityMessage.channelId, input.childChannelId));

  const mediaSnapshot = db
    .select({
      r2Key: communityAttachment.r2Key,
      thumbnailR2Key: communityAttachment.thumbnailR2Key,
    })
    .from(communityAttachment)
    .where(or(
      eq(communityAttachment.messageId, input.openerId),
      inArray(communityAttachment.messageId, childMessageIds),
      and(
        isNull(communityAttachment.messageId),
        eq(communityAttachment.targetId, input.childChannelId),
      ),
    ));

  const repairReadStates = db
    .update(communityReadState)
    .set({
      lastReadMessageId: priorId,
      lastReadSeq: priorSeq,
      lastReadAt: priorCreatedAt,
    })
    .where(and(
      eq(communityReadState.channelId, input.forumChannelId),
      eq(communityReadState.lastReadMessageId, input.openerId),
      openerStillExists,
      priorMessageExists,
    ));

  const removeEmptyReadStates = db
    .delete(communityReadState)
    .where(and(
      eq(communityReadState.channelId, input.forumChannelId),
      eq(communityReadState.lastReadMessageId, input.openerId),
      openerStillExists,
      sql<boolean>`NOT (${priorMessageExists})`,
    ));

  const removePendingAttachments = db
    .delete(communityAttachment)
    .where(and(
      isNull(communityAttachment.messageId),
      eq(communityAttachment.targetId, input.childChannelId),
      openerStillExists,
    ));

  const updateForum = db
    .update(communityChannel)
    .set({
      messageCount: sql<number>`CASE
        WHEN COALESCE(${communityChannel.messageCount}, 0) > 0
          THEN ${communityChannel.messageCount} - 1
        ELSE 0
      END`,
      lastMessageAt: sql<string | null>`(
        SELECT MAX(surviving_message.created_at)
        FROM community_message AS surviving_message
        WHERE surviving_message.channel_id = ${input.forumChannelId}
          AND surviving_message.id != ${input.openerId}
      )`,
    })
    .where(and(
      eq(communityChannel.id, input.forumChannelId),
      openerStillExists,
    ));

  const deleteOpener = db
    .delete(communityMessage)
    .where(and(
      eq(communityMessage.id, input.openerId),
      eq(communityMessage.channelId, input.forumChannelId),
    ))
    .returning({ id: communityMessage.id });

  const results = (await db.batch([
    mediaSnapshot,
    repairReadStates,
    removeEmptyReadStates,
    removePendingAttachments,
    updateForum,
    deleteOpener,
  ] as any)) as unknown[];
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>;
  const deletedRows = results[5] as Array<{ id: string }>;

  return {
    deleted: deletedRows.length > 0,
    mediaKeys: deletedRows.length > 0
      ? mediaRows.flatMap((row) => [row.r2Key, row.thumbnailR2Key].filter((key): key is string => !!key))
      : [],
  };
}

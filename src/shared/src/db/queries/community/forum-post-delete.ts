import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  communityAttachment,
  communityChannel,
  communityForumOpenerRead,
  communityMention,
  communityMessage,
  communityReadState,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import {
  advanceReadStateRevisionsForUsersBuilder,
  type AccountReadStateRevisionByUser,
} from "./read-state";

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
  readStateRevisions: AccountReadStateRevisionByUser[];
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
 *   2. mint account revisions while every destructive read-state effect is
 *      still observable;
 *   3. repair or remove parent-forum read cursors that point at the opener;
 *   4. remove child-scoped pending attachment rows (linked rows cascade);
 *   5. update parent forum count/activity once;
 *   6. delete the opener, whose FK cascades the child channel and its rows.
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
  return deleteForumPostAttempt(db, input, 0);
}

async function deleteForumPostAttempt(
  db: Database,
  input: DeleteForumPostInput,
  attempt: number,
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

  const [impactedPointers, impactedSparse, impactedMentions] = await Promise.all([
    db
      .selectDistinct({ userId: communityReadState.userId })
      .from(communityReadState)
      .innerJoin(user, eq(user.id, communityReadState.userId))
      .where(and(
        eq(user.isBot, false),
        or(
          and(
            eq(communityReadState.channelId, input.forumChannelId),
            eq(communityReadState.lastReadMessageId, input.openerId),
          ),
          eq(communityReadState.channelId, input.childChannelId),
        ),
      )),
    db
      .selectDistinct({ userId: communityForumOpenerRead.userId })
      .from(communityForumOpenerRead)
      .innerJoin(user, eq(user.id, communityForumOpenerRead.userId))
      .where(and(
        eq(user.isBot, false),
        eq(communityForumOpenerRead.openerMessageId, input.openerId),
      )),
    db
      .selectDistinct({ userId: communityMention.userId })
      .from(communityMention)
      .innerJoin(user, eq(user.id, communityMention.userId))
      .where(and(
        eq(user.isBot, false),
        or(
          eq(communityMention.messageId, input.openerId),
          inArray(communityMention.messageId, childMessageIds),
        ),
      )),
  ]);
  const impactedUserIds = [...new Set([
    ...impactedPointers,
    ...impactedSparse,
    ...impactedMentions,
  ].map((row) => row.userId))];
  const impactedIdsJson = JSON.stringify(impactedUserIds);
  // The affected-human set is discovered before batch() because D1 cannot
  // pipe one statement's RETURNING rows into later statements. Close that
  // window optimistically inside the atomic batch: if a new human row enters
  // either destructive scope, every mutation (including the root delete)
  // becomes a no-op and this function re-enumerates. Rows for already-known
  // humans may change safely: their account revision still covers the result,
  // and clients pull the bounded account snapshot from the primary endpoint.
  // Bot rows remain outside this account contract.
  const impactedHumansStable = sql<boolean>`NOT EXISTS (
    SELECT 1 FROM ${user} AS current_user
    WHERE current_user."isBot" = 0
      AND current_user.id NOT IN (
        SELECT CAST(value AS TEXT) FROM json_each(${impactedIdsJson})
      )
      AND (
        EXISTS (
          SELECT 1 FROM ${communityReadState} AS current_state
          WHERE current_state.user_id = current_user.id
            AND (
              (current_state.channel_id = ${input.forumChannelId}
                AND current_state.last_read_message_id = ${input.openerId})
              OR current_state.channel_id = ${input.childChannelId}
            )
        )
        OR EXISTS (
          SELECT 1 FROM ${communityForumOpenerRead} AS current_sparse
          WHERE current_sparse.user_id = current_user.id
            AND current_sparse.opener_message_id = ${input.openerId}
        )
        OR EXISTS (
          SELECT 1 FROM ${communityMention} AS current_mention
          INNER JOIN ${communityMessage} AS mentioned_message
            ON mentioned_message.id = current_mention.message_id
          WHERE current_mention.user_id = current_user.id
            AND (
              current_mention.message_id = ${input.openerId}
              OR mentioned_message.channel_id = ${input.childChannelId}
            )
        )
      )
  )`;
  const enumeratedUserHasEffect = sql<boolean>`EXISTS (
    SELECT 1 FROM ${user} AS enumerated_user
    WHERE enumerated_user.id = CAST(value AS TEXT)
      AND enumerated_user."isBot" = 0
      AND (
        EXISTS (
          SELECT 1 FROM ${communityReadState} AS current_state
          WHERE current_state.user_id = enumerated_user.id
            AND (
              (current_state.channel_id = ${input.forumChannelId}
                AND current_state.last_read_message_id = ${input.openerId})
              OR current_state.channel_id = ${input.childChannelId}
            )
        )
        OR EXISTS (
          SELECT 1 FROM ${communityForumOpenerRead} AS current_sparse
          WHERE current_sparse.user_id = enumerated_user.id
            AND current_sparse.opener_message_id = ${input.openerId}
        )
        OR EXISTS (
          SELECT 1 FROM ${communityMention} AS current_mention
          INNER JOIN ${communityMessage} AS mentioned_message
            ON mentioned_message.id = current_mention.message_id
          WHERE current_mention.user_id = enumerated_user.id
            AND (
              current_mention.message_id = ${input.openerId}
              OR mentioned_message.channel_id = ${input.childChannelId}
            )
        )
      )
  )`;
  const rowBelongsToKnownHumanOrBot = sql<boolean>`(
    ${communityReadState.userId} IN (
      SELECT CAST(value AS TEXT) FROM json_each(${impactedIdsJson})
    )
    OR EXISTS (
      SELECT 1 FROM ${user} AS state_user
      WHERE state_user.id = ${communityReadState.userId}
        AND state_user."isBot" = 1
    )
  )`;

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
      impactedHumansStable,
      rowBelongsToKnownHumanOrBot,
    ));

  const removeEmptyReadStates = db
    .delete(communityReadState)
    .where(and(
      eq(communityReadState.channelId, input.forumChannelId),
      eq(communityReadState.lastReadMessageId, input.openerId),
      openerStillExists,
      sql<boolean>`NOT (${priorMessageExists})`,
      impactedHumansStable,
      rowBelongsToKnownHumanOrBot,
    ));

  const removePendingAttachments = db
    .delete(communityAttachment)
    .where(and(
      isNull(communityAttachment.messageId),
      eq(communityAttachment.targetId, input.childChannelId),
      openerStillExists,
      impactedHumansStable,
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
      impactedHumansStable,
    ));

  const deleteOpener = db
    .delete(communityMessage)
    .where(and(
      eq(communityMessage.id, input.openerId),
      eq(communityMessage.channelId, input.forumChannelId),
      impactedHumansStable,
    ))
    .returning({ id: communityMessage.id });

  const revisionIndex = 1;
  const deleteIndex = impactedUserIds.length > 0 ? 6 : 5;
  const results = (await db.batch([
    mediaSnapshot,
    ...(impactedUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
          db,
          impactedUserIds,
          and(openerStillExists, impactedHumansStable, enumeratedUserHasEffect)!,
        )]
      : []),
    repairReadStates,
    removeEmptyReadStates,
    removePendingAttachments,
    updateForum,
    deleteOpener,
  ] as any)) as unknown[];
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>;
  const deletedRows = results[deleteIndex] as Array<{ id: string }>;
  const revisions = impactedUserIds.length > 0
    ? results[revisionIndex] as Array<{ userId: string; revision: number }>
    : [];

  const deleted = deletedRows.length > 0;
  if (!deleted) {
    const roots = await db
      .select({ id: communityMessage.id })
      .from(communityMessage)
      .where(and(
        eq(communityMessage.id, input.openerId),
        eq(communityMessage.channelId, input.forumChannelId),
      ))
      .limit(1);
    if (roots.length > 0) {
      if (attempt >= 4) throw new Error("forum read-state audience did not stabilize");
      return deleteForumPostAttempt(db, input, attempt + 1);
    }
  }

  return {
    deleted,
    mediaKeys: deleted
      ? mediaRows.flatMap((row) => [row.r2Key, row.thumbnailR2Key].filter((key): key is string => !!key))
      : [],
    readStateRevisions: deleted ? revisions : [],
  };
}

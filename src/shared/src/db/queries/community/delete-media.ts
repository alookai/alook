import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm"
import {
  communityAttachment,
  communityChannel,
  communityMessage,
  communityReadState,
  communityServer,
} from "../../community-schema"
import { user } from "../../schema"
import type { Database } from "../../index"
import {
  advanceReadStateRevisionsForUsersBuilder,
  type AccountReadStateRevisionByUser,
} from "./read-state"

export type DeleteCommunityMediaResult = {
  deleted: boolean
  mediaKeys: string[]
  readStateRevisions: AccountReadStateRevisionByUser[]
}

export type DeleteServerWithMediaResult = DeleteCommunityMediaResult & {
  iconKey: string | null
}

function flattenMediaRows(
  rows: Array<{ r2Key: string; thumbnailR2Key: string | null }>,
): string[] {
  return rows.flatMap((row) => [row.r2Key, row.thumbnailR2Key]
    .filter((key): key is string => key !== null && key.length > 0))
}

export async function deleteChannelWithMedia(
  db: Database,
  input: { channelId: string; serverId: string },
): Promise<DeleteCommunityMediaResult> {
  return deleteChannelWithMediaAttempt(db, input, 0)
}

async function deleteChannelWithMediaAttempt(
  db: Database,
  input: { channelId: string; serverId: string },
  attempt: number,
): Promise<DeleteCommunityMediaResult> {
  const rootQuery = db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(and(
      eq(communityChannel.id, input.channelId),
      eq(communityChannel.serverId, input.serverId),
    ))
    .limit(1)
  const rootStillExists = exists(rootQuery)
  const scopedChannelIds = db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(and(
      eq(communityChannel.serverId, input.serverId),
      or(
        eq(communityChannel.id, input.channelId),
        eq(communityChannel.parentChannelId, input.channelId),
      ),
    ))
  const scopedMessageIds = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(inArray(communityMessage.channelId, scopedChannelIds))
  const impactedHumans = await db
    .selectDistinct({ userId: communityReadState.userId })
    .from(communityReadState)
    .innerJoin(user, eq(user.id, communityReadState.userId))
    .where(and(
      eq(user.isBot, false),
      inArray(communityReadState.channelId, scopedChannelIds),
    ))
  const impactedUserIds = impactedHumans.map((row) => row.userId)
  const impactedIdsJson = JSON.stringify(impactedUserIds)
  const impactedHumansStable = sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${communityReadState} AS current_state
    INNER JOIN ${user} AS current_user ON current_user.id = current_state.user_id
    WHERE current_user."isBot" = 0
      AND current_state.channel_id IN (
        SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
        WHERE scoped_channel.server_id = ${input.serverId}
          AND (
            scoped_channel.id = ${input.channelId}
            OR scoped_channel.parent_channel_id = ${input.channelId}
          )
      )
      AND current_state.user_id NOT IN (
        SELECT CAST(value AS TEXT) FROM json_each(${impactedIdsJson})
      )
  )`

  const mediaSnapshot = db
    .select({
      r2Key: communityAttachment.r2Key,
      thumbnailR2Key: communityAttachment.thumbnailR2Key,
    })
    .from(communityAttachment)
    .where(and(
      rootStillExists,
      or(
        inArray(communityAttachment.messageId, scopedMessageIds),
        and(
          isNull(communityAttachment.messageId),
          inArray(communityAttachment.targetId, scopedChannelIds),
        ),
      ),
    ))

  const removePendingAttachments = db
    .delete(communityAttachment)
    .where(and(
      rootStillExists,
      isNull(communityAttachment.messageId),
      inArray(communityAttachment.targetId, scopedChannelIds),
      impactedHumansStable,
    ))

  const deleteRoot = db
    .delete(communityChannel)
    .where(and(
      eq(communityChannel.id, input.channelId),
      eq(communityChannel.serverId, input.serverId),
      impactedHumansStable,
    ))
    .returning({ id: communityChannel.id })

  const revisionIndex = 2
  const deleteIndex = impactedUserIds.length > 0 ? 3 : 2
  const results = (await db.batch([
    mediaSnapshot,
    removePendingAttachments,
    ...(impactedUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
          db,
          impactedUserIds,
          and(rootStillExists, impactedHumansStable)!,
        )]
      : []),
    deleteRoot,
  ] as any)) as unknown[]
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>
  const deletedRows = results[deleteIndex] as Array<{ id: string }>
  const deleted = deletedRows.length > 0
  const revisions = impactedUserIds.length > 0
    ? results[revisionIndex] as Array<{ userId: string; revision: number }>
    : []

  if (!deleted) {
    const roots = await rootQuery
    if (roots.length > 0) {
      if (attempt >= 4) throw new Error("channel read-state audience did not stabilize")
      return deleteChannelWithMediaAttempt(db, input, attempt + 1)
    }
  }

  return {
    deleted,
    mediaKeys: deleted ? flattenMediaRows(mediaRows) : [],
    readStateRevisions: deleted ? revisions : [],
  }
}

export async function deleteServerWithMedia(
  db: Database,
  input: { serverId: string; ownerId: string },
): Promise<DeleteServerWithMediaResult> {
  return deleteServerWithMediaAttempt(db, input, 0)
}

async function deleteServerWithMediaAttempt(
  db: Database,
  input: { serverId: string; ownerId: string },
  attempt: number,
): Promise<DeleteServerWithMediaResult> {
  const ownedServerQuery = db
    .select({ id: communityServer.id })
    .from(communityServer)
    .where(and(
      eq(communityServer.id, input.serverId),
      eq(communityServer.ownerId, input.ownerId),
    ))
    .limit(1)
  const ownedServerStillExists = exists(ownedServerQuery)
  const scopedChannelIds = db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(eq(communityChannel.serverId, input.serverId))
  const scopedMessageIds = db
    .select({ id: communityMessage.id })
    .from(communityMessage)
    .where(inArray(communityMessage.channelId, scopedChannelIds))
  const impactedHumans = await db
    .selectDistinct({ userId: communityReadState.userId })
    .from(communityReadState)
    .innerJoin(user, eq(user.id, communityReadState.userId))
    .where(and(
      eq(user.isBot, false),
      inArray(communityReadState.channelId, scopedChannelIds),
    ))
  const impactedUserIds = impactedHumans.map((row) => row.userId)
  const impactedIdsJson = JSON.stringify(impactedUserIds)
  const impactedHumansStable = sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${communityReadState} AS current_state
    INNER JOIN ${user} AS current_user ON current_user.id = current_state.user_id
    WHERE current_user."isBot" = 0
      AND current_state.channel_id IN (
        SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
        WHERE scoped_channel.server_id = ${input.serverId}
      )
      AND current_state.user_id NOT IN (
        SELECT CAST(value AS TEXT) FROM json_each(${impactedIdsJson})
      )
  )`

  const mediaSnapshot = db
    .select({
      r2Key: communityAttachment.r2Key,
      thumbnailR2Key: communityAttachment.thumbnailR2Key,
    })
    .from(communityAttachment)
    .where(and(
      ownedServerStillExists,
      or(
        inArray(communityAttachment.messageId, scopedMessageIds),
        and(
          isNull(communityAttachment.messageId),
          inArray(communityAttachment.targetId, scopedChannelIds),
        ),
      ),
    ))

  const removePendingAttachments = db
    .delete(communityAttachment)
    .where(and(
      ownedServerStillExists,
      isNull(communityAttachment.messageId),
      inArray(communityAttachment.targetId, scopedChannelIds),
      impactedHumansStable,
    ))

  const deleteServer = db
    .delete(communityServer)
    .where(and(
      eq(communityServer.id, input.serverId),
      eq(communityServer.ownerId, input.ownerId),
      impactedHumansStable,
    ))
    .returning({ id: communityServer.id, icon: communityServer.icon })

  const revisionIndex = 2
  const deleteIndex = impactedUserIds.length > 0 ? 3 : 2
  const results = (await db.batch([
    mediaSnapshot,
    removePendingAttachments,
    ...(impactedUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
          db,
          impactedUserIds,
          and(ownedServerStillExists, impactedHumansStable)!,
        )]
      : []),
    deleteServer,
  ] as any)) as unknown[]
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>
  const deletedRows = results[deleteIndex] as Array<{ id: string; icon: string | null }>
  const deleted = deletedRows.length > 0
  const revisions = impactedUserIds.length > 0
    ? results[revisionIndex] as Array<{ userId: string; revision: number }>
    : []

  if (!deleted) {
    const roots = await ownedServerQuery
    if (roots.length > 0) {
      if (attempt >= 4) throw new Error("server read-state audience did not stabilize")
      return deleteServerWithMediaAttempt(db, input, attempt + 1)
    }
  }

  return {
    deleted,
    mediaKeys: deleted ? flattenMediaRows(mediaRows) : [],
    iconKey: deleted ? deletedRows[0]!.icon : null,
    readStateRevisions: deleted ? revisions : [],
  }
}

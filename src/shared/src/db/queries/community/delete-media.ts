import { advanceReadStateRevisionsForUsersBuilder, humanUserExistsCondition } from "./read-state-revision";
import { and, eq, exists, inArray, or, notExists, notInArray, sql } from "drizzle-orm"
import {
  communityChannel,
  communityMention,
  communityMessage,
  communityReadState,
  communityServer,
} from "../../community-schema"
import type { Database } from "../../index"
import { jsonTextSet } from "../_json-set"
import {
  type AccountReadStateRevisionByUser,
} from "./read-state"

export type DeleteCommunityMediaResult = {
  deleted: boolean
  readStateRevisions: AccountReadStateRevisionByUser[]
}

export type DeleteServerWithMediaResult = DeleteCommunityMediaResult & {
  iconKey: string | null
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
  const impactedHumanQueries = [
    db
      .selectDistinct({ userId: communityReadState.userId })
      .from(communityReadState)
      .where(and(
        humanUserExistsCondition(db, communityReadState.userId),
        inArray(communityReadState.channelId, scopedChannelIds),
      )),
    db
      .selectDistinct({ userId: communityMention.userId })
      .from(communityMention)
      .where(and(
        humanUserExistsCondition(db, communityMention.userId),
        inArray(communityMention.messageId, scopedMessageIds),
      )),
  ] as const
  const [impactedPointers, impactedMentions] = await Promise.all(impactedHumanQueries)
  const currentImpactedUserIds = impactedHumanQueries[0].union(impactedHumanQueries[1]).as("current_impacted_humans")
  const impactedUserIds = [...new Set([
    ...impactedPointers,
    ...impactedMentions,
  ].map((row) => row.userId))]
  const scopedHumanEffectSql = (userIdSql: ReturnType<typeof sql>) => sql<boolean>`(
    EXISTS (
      SELECT 1 FROM ${communityReadState} AS current_state
      WHERE current_state.user_id = ${userIdSql}
        AND current_state.channel_id IN (
          SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
          WHERE scoped_channel.server_id = ${input.serverId}
            AND (
              scoped_channel.id = ${input.channelId}
              OR scoped_channel.parent_channel_id = ${input.channelId}
            )
        )
    )
    OR EXISTS (
      SELECT 1 FROM ${communityMention} AS current_mention
      INNER JOIN ${communityMessage} AS mentioned_message
        ON mentioned_message.id = current_mention.message_id
      WHERE current_mention.user_id = ${userIdSql}
        AND mentioned_message.channel_id IN (
          SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
          WHERE scoped_channel.server_id = ${input.serverId}
            AND (
              scoped_channel.id = ${input.channelId}
              OR scoped_channel.parent_channel_id = ${input.channelId}
            )
        )
    )
  )`
  const impactedHumansStable = notExists(db.select({ one: sql<number>`1` })
    .from(currentImpactedUserIds)
    .where(notInArray(currentImpactedUserIds.userId, jsonTextSet(db, impactedUserIds))))
  const enumeratedUserHasEffect = scopedHumanEffectSql(sql`CAST(value AS TEXT)`)

  const deleteRoot = db
    .delete(communityChannel)
    .where(and(
      eq(communityChannel.id, input.channelId),
      eq(communityChannel.serverId, input.serverId),
      impactedHumansStable,
    ))
    .returning({ id: communityChannel.id })

  const revisionIndex = 0
  const deleteIndex = impactedUserIds.length > 0 ? 1 : 0
  const results = (await db.batch([
    ...(impactedUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
          db,
          impactedUserIds,
          and(rootStillExists, impactedHumansStable, enumeratedUserHasEffect)!,
        )]
      : []),
    deleteRoot,
  ] as any)) as unknown[]
  const deletedRows = results[deleteIndex] as Array<{ id: string }>
  const deleted = deletedRows.length > 0
  const revisions = impactedUserIds.length > 0
    ? results[revisionIndex] as Array<{ userId: string; revision: number }>
    : []

  if (!deleted) {
    const roots = await rootQuery
    /* istanbul ignore if -- real workerd stable-guard retry/exhaustion oracle */
    if (roots.length > 0) {
      if (attempt >= 4) throw new Error("channel read-state audience did not stabilize")
      return deleteChannelWithMediaAttempt(db, input, attempt + 1)
    }
  }

  return {
    deleted,
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
  const impactedHumanQueries = [
    db
      .selectDistinct({ userId: communityReadState.userId })
      .from(communityReadState)
      .where(and(
        humanUserExistsCondition(db, communityReadState.userId),
        inArray(communityReadState.channelId, scopedChannelIds),
      )),
    db
      .selectDistinct({ userId: communityMention.userId })
      .from(communityMention)
      .where(and(
        humanUserExistsCondition(db, communityMention.userId),
        inArray(communityMention.messageId, scopedMessageIds),
      )),
  ] as const
  const [impactedPointers, impactedMentions] = await Promise.all(impactedHumanQueries)
  const currentImpactedUserIds = impactedHumanQueries[0].union(impactedHumanQueries[1]).as("current_impacted_humans")
  const impactedUserIds = [...new Set([
    ...impactedPointers,
    ...impactedMentions,
  ].map((row) => row.userId))]
  const scopedHumanEffectSql = (userIdSql: ReturnType<typeof sql>) => sql<boolean>`(
    EXISTS (
      SELECT 1 FROM ${communityReadState} AS current_state
      WHERE current_state.user_id = ${userIdSql}
        AND current_state.channel_id IN (
          SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
          WHERE scoped_channel.server_id = ${input.serverId}
        )
    )
    OR EXISTS (
      SELECT 1 FROM ${communityMention} AS current_mention
      INNER JOIN ${communityMessage} AS mentioned_message
        ON mentioned_message.id = current_mention.message_id
      WHERE current_mention.user_id = ${userIdSql}
        AND mentioned_message.channel_id IN (
          SELECT scoped_channel.id FROM ${communityChannel} AS scoped_channel
          WHERE scoped_channel.server_id = ${input.serverId}
        )
    )
  )`
  const impactedHumansStable = notExists(db.select({ one: sql<number>`1` })
    .from(currentImpactedUserIds)
    .where(notInArray(currentImpactedUserIds.userId, jsonTextSet(db, impactedUserIds))))
  const enumeratedUserHasEffect = scopedHumanEffectSql(sql`CAST(value AS TEXT)`)

  const deleteServer = db
    .delete(communityServer)
    .where(and(
      eq(communityServer.id, input.serverId),
      eq(communityServer.ownerId, input.ownerId),
      impactedHumansStable,
    ))
    .returning({ id: communityServer.id, icon: communityServer.icon })

  const revisionIndex = 0
  const deleteIndex = impactedUserIds.length > 0 ? 1 : 0
  const results = (await db.batch([
    ...(impactedUserIds.length > 0
      ? [advanceReadStateRevisionsForUsersBuilder(
          db,
          impactedUserIds,
          and(ownedServerStillExists, impactedHumansStable, enumeratedUserHasEffect)!,
        )]
      : []),
    deleteServer,
  ] as any)) as unknown[]
  const deletedRows = results[deleteIndex] as Array<{ id: string; icon: string | null }>
  const deleted = deletedRows.length > 0
  const revisions = impactedUserIds.length > 0
    ? results[revisionIndex] as Array<{ userId: string; revision: number }>
    : []

  if (!deleted) {
    const roots = await ownedServerQuery
    /* istanbul ignore if -- real workerd stable-guard retry/exhaustion oracle */
    if (roots.length > 0) {
      if (attempt >= 4) throw new Error("server read-state audience did not stabilize")
      return deleteServerWithMediaAttempt(db, input, attempt + 1)
    }
  }

  return {
    deleted,
    iconKey: deleted ? deletedRows[0]!.icon : null,
    readStateRevisions: deleted ? revisions : [],
  }
}

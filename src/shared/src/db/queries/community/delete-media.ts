import { and, eq, exists, inArray, isNull, or } from "drizzle-orm"
import {
  communityAttachment,
  communityChannel,
  communityMessage,
  communityServer,
} from "../../community-schema"
import type { Database } from "../../index"

export type DeleteCommunityMediaResult = {
  deleted: boolean
  mediaKeys: string[]
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
    ))

  const deleteRoot = db
    .delete(communityChannel)
    .where(and(
      eq(communityChannel.id, input.channelId),
      eq(communityChannel.serverId, input.serverId),
    ))
    .returning({ id: communityChannel.id })

  const results = (await db.batch([
    mediaSnapshot,
    removePendingAttachments,
    deleteRoot,
  ] as any)) as unknown[]
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>
  const deletedRows = results[2] as Array<{ id: string }>
  const deleted = deletedRows.length > 0

  return {
    deleted,
    mediaKeys: deleted ? flattenMediaRows(mediaRows) : [],
  }
}

export async function deleteServerWithMedia(
  db: Database,
  input: { serverId: string; ownerId: string },
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
    ))

  const deleteServer = db
    .delete(communityServer)
    .where(and(
      eq(communityServer.id, input.serverId),
      eq(communityServer.ownerId, input.ownerId),
    ))
    .returning({ id: communityServer.id, icon: communityServer.icon })

  const results = (await db.batch([
    mediaSnapshot,
    removePendingAttachments,
    deleteServer,
  ] as any)) as unknown[]
  const mediaRows = results[0] as Array<{ r2Key: string; thumbnailR2Key: string | null }>
  const deletedRows = results[2] as Array<{ id: string; icon: string | null }>
  const deleted = deletedRows.length > 0

  return {
    deleted,
    mediaKeys: deleted ? flattenMediaRows(mediaRows) : [],
    iconKey: deleted ? deletedRows[0]!.icon : null,
  }
}

import { queries, withD1Retry } from "@alook/shared"
import type { getDb } from "@/lib/db"
import { groupAttachments, groupReactions } from "@/lib/community/messages"
import { mapMessageForApi } from "@/lib/community/message-payload"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"

// Message enrichment shared by the channel messages route, the channel
// bootstrap route, and the DM messages route (previously three near-identical
// copies — see plans/community-switch-perf-optimization.md WS2). Attaches
// attachments, reactions, reply-target previews, `latestSeq`, and — for
// non-DM channel scope only — child-channel thread indicators.
//
// `items` is expected in chronological ASC (the wire order). Every scope is a
// channel now (a DM is a type=dm channel); `isDm` toggles the DM-only
// approval-card hydration and skips child-channel threads.

type Db = ReturnType<typeof getDb>

export type MessageScope = { channelId: string; isDm?: boolean; isForum?: boolean }

export async function enrichMessages(
  db: Db,
  userId: string,
  scope: MessageScope,
  items: Array<{ id: string; replyToId: string | null } & Record<string, unknown>>,
): Promise<{ messages: unknown[]; latestSeq: number }> {
  const isDm = scope.isDm === true
  const messageIds = items.map((m) => m.id)
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]

  const [allAttachments, allReactions, replyMessages, childChannels, latestSeq, approvalByMessageId] = await Promise.all([
    messageIds.length > 0
      ? queries.communityAttachment.listByMessageIds(db, messageIds)
      : Promise.resolve([]),
    messageIds.length > 0
      ? queries.communityReaction.listReactionsByMessageIds(db, messageIds, userId)
      : Promise.resolve([]),
    replyToIds.length > 0
      ? withD1Retry(
        () => queries.communityMessage.getMessagesByIdsInScope(db, replyToIds, { channelId: scope.channelId }),
        { route: "community/messages:reply-enrichment" },
      )
      : Promise.resolve([]),
    // Thread indicators only exist for non-DM channel-scoped messages.
    !isDm
      ? scope.isForum
        ? queries.communityChannel.listChildChannelsByParentMessageIds(db, scope.channelId, messageIds)
        : queries.communityChannel.listChildChannels(db, scope.channelId)
      : Promise.resolve([]),
    queries.communityMessage.getLatestMessageSeq(db, { channelId: scope.channelId }),
    // Friend-approval cards only ever live in DMs — skip the hydration query
    // for non-DM channel scope entirely.
    isDm && messageIds.length > 0
      ? queries.communityFriendship.hydrateApprovalsForDmMessages(db, messageIds, userId)
      : Promise.resolve(new Map()),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, userId)
  const replyMap = new Map(replyMessages.map((m) => [m.id, m]))

  const threadIds = childChannels.map((channel) => channel.id)
  const [forumTags, forumFirstMessages, forumParticipants] = scope.isForum && messageIds.length > 0
    ? await Promise.all([
      queries.communityMessageTag.listTagsForMessages(db, messageIds),
      queries.communityMessage.getFirstMessageByChannelIds(db, threadIds),
      queries.communityThread.listParticipantsForChannels(db, threadIds, 5),
    ])
    : [[], [], []]
  const tagsByMessage = new Map<string, string[]>()
  for (const row of forumTags) {
    tagsByMessage.set(row.messageId, [...(tagsByMessage.get(row.messageId) ?? []), row.tag])
  }
  const firstByChannel = new Map(forumFirstMessages.map((message) => [message.channelId, message]))
  const participantsByChannel = new Map<string, Array<{
    id: string
    name: string
    avatar: string
    avatarVersion: number
  }>>()
  const participantCountByChannel = new Map<string, number>()
  for (const row of forumParticipants) {
    participantCountByChannel.set(
      row.channelId,
      "participantCount" in row ? Number(row.participantCount) : 0,
    )
    participantsByChannel.set(row.channelId, [
      ...(participantsByChannel.get(row.channelId) ?? []),
      {
        id: row.userId,
        name: row.userName ?? "",
        avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion)
          ?? avatarInitial(row.userName ?? ""),
        avatarVersion: row.userAvatarVersion,
      },
    ])
  }

  const threadByMessageId = new Map(
    childChannels
      .filter((c) => c.parentMessageId)
      .map((c) => {
        const first = firstByChannel.get(c.id)
        return [c.parentMessageId!, {
          id: c.id,
          name: c.name,
          messageCount: c.messageCount ?? 0,
          lastReplyAt: c.lastMessageAt ?? c.createdAt,
          ...(scope.isForum ? {
            tags: tagsByMessage.get(c.parentMessageId!) ?? [],
            preview: (first?.content ?? "").slice(0, 100),
            participants: participantsByChannel.get(c.id) ?? [],
            participantCount: participantCountByChannel.get(c.id) ?? 0,
          } : {}),
        }] as const
      }),
  )

  const messages = items.map((r) =>
    mapMessageForApi(r as never, {
      replyMap,
      attachmentsByMessage,
      reactionsByMessage,
      threadByMessageId,
      approvalByMessageId: approvalByMessageId as Map<string, import("@alook/shared").FriendApprovalPayload>,
    }),
  )
  return { messages, latestSeq }
}

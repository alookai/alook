import { queries, withD1Retry } from "@alook/shared"
import type { getDb } from "@/lib/db"
import { groupAttachments, groupReactions } from "@/lib/community/messages"
import { mapMessageForApi } from "@/lib/community/message-payload"

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

export type MessageScope = { channelId: string; isDm?: boolean }

export async function enrichMessages(
  db: Db,
  userId: string,
  scope: MessageScope,
  items: Array<{ id: string; replyToId: string | null } & Record<string, unknown>>,
): Promise<{ messages: unknown[]; latestSeq: number }> {
  const isDm = scope.isDm === true
  const messageIds = items.map((m) => m.id)
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]

  // `withD1Retry` (D1-armor: no-fallback message-enrichment read fan; retry the
  // whole batch to truth rather than 500 a message list on a transient).
  const [allAttachments, allReactions, replyMessages, childChannels, latestSeq, approvalByMessageId] = await withD1Retry(
    () =>
      Promise.all([
        messageIds.length > 0
          ? queries.communityAttachment.listByMessageIds(db, messageIds)
          : Promise.resolve([]),
        messageIds.length > 0
          ? queries.communityReaction.listReactionsByMessageIds(db, messageIds, userId)
          : Promise.resolve([]),
        replyToIds.length > 0
          ? queries.communityMessage.getMessagesByIdsInScope(db, replyToIds, { channelId: scope.channelId })
          : Promise.resolve([]),
        // Thread indicators only exist for non-DM channel-scoped messages.
        !isDm
          ? queries.communityChannel.listChildChannels(db, scope.channelId)
          : Promise.resolve([]),
        queries.communityMessage.getLatestMessageSeq(db, { channelId: scope.channelId }),
        // Friend-approval cards only ever live in DMs — skip the hydration query
        // for non-DM channel scope entirely.
        isDm && messageIds.length > 0
          ? queries.communityFriendship.hydrateApprovalsForDmMessages(db, messageIds, userId)
          : Promise.resolve(new Map()),
      ]),
    { route: "enrich-messages" },
  )

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, userId)
  const replyMap = new Map(replyMessages.map((m) => [m.id, m]))

  const threadByMessageId = new Map(
    childChannels
      .filter((c) => c.parentMessageId)
      .map((c) => [c.parentMessageId!, { id: c.id, name: c.name, messageCount: c.messageCount ?? 0 }] as const),
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

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"
import { groupAttachments, groupReactions } from "@/lib/community/messages"
import { mapMessageForApi } from "@/lib/community/message-payload"

/**
 * GET /api/community/messages/[id]
 *
 * Returns a single fully-hydrated message (attachments + reactions + reply
 * preview) shaped by `mapMessageForApi`. Currently the only client of this is
 * the thread-view "opener" block — when the user opens a thread channel, the
 * client fetches the parent message via its `parentMessageId` pointer and
 * renders it pinned at the top of the message list.
 *
 * Access model: the caller must have access to the surface the message lives
 * in — a server member for channel messages, a DM participant for DM messages.
 * This is deliberately the SAME check as GET /channels/[id]/messages: since
 * server membership grants access to every channel in the server, a thread
 * viewer who can read the thread's messages can also read the outer channel's
 * parent-message opener. No separate "is this a parentMessageId of a thread I
 * can see" branch is needed — the server-scoped check subsumes it.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  if (message.channelId) {
    const auth = await requireChannelMember(db, message.channelId, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
  } else if (message.dmConversationId) {
    const auth = await requireDMParticipant(db, message.dmConversationId, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
  } else {
    // Row with neither channelId nor dmConversationId shouldn't exist in
    // practice (both nullable in schema, but creation always sets one). Treat
    // as not-found rather than leaking existence.
    return writeError("message not found", 404)
  }

  // Hydrate attachments, reactions, and reply target — same shape as the
  // list endpoint. Run in parallel; all three depend only on `messageId`.
  const [allAttachments, allReactions, replyMessages] = await Promise.all([
    queries.communityAttachment.listByMessageIds(db, [messageId]),
    queries.communityReaction.listReactionsByMessageIds(db, [messageId], ctx.userId),
    message.replyToId
      ? queries.communityMessage.getMessagesByIds(db, [message.replyToId])
      : Promise.resolve([]),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  // Scope-check the reply target against the SAME surface as the parent — a
  // reply preview must not leak content from a different channel/DM.
  const replyMap = new Map(
    replyMessages
      .filter((m) =>
        message.channelId
          ? m.channelId === message.channelId
          : m.dmConversationId === message.dmConversationId,
      )
      .map((m) => [m.id, m]),
  )

  const payload = mapMessageForApi(message, {
    replyMap,
    attachmentsByMessage,
    reactionsByMessage,
  })

  return writeJSON(payload)
})

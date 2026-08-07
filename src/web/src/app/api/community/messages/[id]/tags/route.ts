import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  MAX_FORUM_TAG_LENGTH,
  MAX_FORUM_TAGS_PER_POST,
} from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

/** Replace the tag set on a forum opener message. */
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { tags?: unknown }).tags)) {
    return writeError("tags must be an array", 400)
  }
  const input = (raw as { tags: unknown[] }).tags
  if (input.some((tag) => typeof tag !== "string")) {
    return writeError("tags must contain only strings", 400)
  }
  const tags = [...new Set((input as string[]).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
  if (tags.length > MAX_FORUM_TAGS_PER_POST) {
    return writeError(`too many tags (max ${MAX_FORUM_TAGS_PER_POST})`, 400)
  }
  if (tags.some((tag) => tag.length > MAX_FORUM_TAG_LENGTH)) {
    return writeError(`tag must be ≤ ${MAX_FORUM_TAG_LENGTH} characters`, 400)
  }

  const db = getDb(ctx.env.DB)
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  const access = await requireChannelAccess(db, message.channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.channel.type !== "forum") {
    return writeError("tags are only supported on forum opener messages", 400)
  }
  const thread = await queries.communityChannel.getThreadChannelByParentMessage(
    db,
    message.channelId,
    message.id,
  )
  if (!thread || thread.type !== "thread") {
    return writeError("message is not a forum opener", 400)
  }

  const mayEdit = message.authorId === ctx.userId || canManageServer(access.value.member.role)
  if (!mayEdit) return writeError("forbidden", 403)

  await queries.communityMessageTag.replaceMessageTags(db, { messageId, tags })

  return writeJSON({ tags })
})

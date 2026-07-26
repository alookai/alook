import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { CreateChannelRequestSchema } from "@alook/shared"
import { createChannelUnified, type CreateChannelServiceInput } from "@/lib/community/channel-service"

/**
 * POST /api/community/channels — the single create endpoint for all four
 * channel types (text / forum / post / thread), keyed on a discriminated-union
 * body. Absorbs the old POST /servers/[id]/channels, /channels/[id]/posts, and
 * /messages/[id]/threads. Always returns `201 { channel: ChannelDTO }` — a
 * unified envelope across all four types (the post arm additionally fills the
 * card fields creator/preview/participants/tags/messageCount).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const parsed = CreateChannelRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return writeError(first?.message ?? "invalid request body", 400)
  }
  const body = parsed.data

  let input: CreateChannelServiceInput
  if (body.type === "post") {
    input = {
      type: "post",
      parentChannelId: body.parentChannelId,
      name: body.name,
      content: body.content,
      attachments: body.attachments,
      mentionType: body.mentionType,
    }
  } else if (body.type === "thread") {
    input = { type: "thread", parentMessageId: body.parentMessageId, name: body.name }
  } else {
    input = {
      type: body.type,
      serverId: body.serverId,
      name: body.name,
      categoryId: body.categoryId ?? null,
      topic: body.topic,
    }
  }

  const result = await createChannelUnified(db, { userId: ctx.userId }, input)
  if (!result.ok) return writeError(result.error, result.status)

  // Thread dedupe: the service returns the existing winner with `created:false`
  // (one thread per message). On the human route that's a 409 conflict — the
  // agent `resolve-ref` path is the only caller that treats the reuse as success.
  if (!result.created) return writeError("message already has a thread", 409)

  return writeJSON({ channel: result.channel }, 201)
})

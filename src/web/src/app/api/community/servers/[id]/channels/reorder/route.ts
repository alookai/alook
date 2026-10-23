import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getPrimaryDb } from "@/lib/db"
import { channelReorderRequestSchema, queries, WS_EVENTS } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { requireServerAdmin } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)
  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  let body: unknown
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  const parsed = channelReorderRequestSchema.safeParse(body)
  if (!parsed.success) return writeError(parsed.error.issues[0]?.message ?? "invalid channel order", 400)
  const { channelIds, move } = parsed.data
  const channels = await queries.communityChannel.getServerRootChannelsByIds(db, serverId, channelIds)
  if (channels.length !== channelIds.length) return writeError("one or more server channels not found", 404)
  if (move) {
    const categories = await queries.communityCategory.listCategoriesByServer(db, serverId)
    const moving = channels.find((channel) => channel.id === move.channelId)!
    const source = moving.categoryId ? categories.find((category) => category.id === moving.categoryId) : null
    const target = move.categoryId ? categories.find((category) => category.id === move.categoryId) : null
    if ((moving.categoryId && !source) || (move.categoryId && !target)) return writeError("category not found", 404)
    if (!!source?.private !== !!target?.private) return writeError("Can't move a channel across a public/private boundary", 400)
  }
  await queries.communityChannel.reorderChannels(db, serverId, channelIds, move)
  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CHANNEL_REORDER, serverId,
    channels: channelIds.map((id, position) => ({ id, position })),
  })
  return writeJSON({ ok: true })
})

import type { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"

const PREVIEW_LIMIT = 4

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const db = getDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const rows = await queries.communityMessageMark.listMarksForUser(db, botId, {
    limit: PREVIEW_LIMIT,
  })
  const channelIds = [...new Set(rows.map(({ mark }) => mark.channelId))]
  const channels = channelIds.length > 0
    ? await queries.communityChannel.getChannelsByIds(db, channelIds)
    : []
  const serverIds = [...new Set(channels.flatMap((channel) =>
    channel.serverId ? [channel.serverId] : []))]
  const servers = serverIds.length > 0
    ? await queries.communityServer.getServersByIds(db, serverIds)
    : []
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]))
  const serversById = new Map(servers.map((server) => [server.id, server]))

  return writeJSON({
    marked: rows.map(({ mark, message, author }) => {
      const channel = channelsById.get(mark.channelId)
      const server = channel ? serversById.get(channel.serverId) : undefined
      return {
        id: mark.id,
        server: server?.name ?? "",
        serverId: channel?.serverId ?? null,
        channel: channel?.name ?? "",
        channelId: mark.channelId,
        parentChannelId: channel?.parentChannelId ?? null,
        m: {
          id: message.id,
          authorId: author.id,
          authorName: author.name,
          authorAvatar: canonicalUserImage(author.id, author.image, author.avatarVersion)
            ?? avatarInitial(author.name),
          authorAvatarVersion: author.avatarVersion,
          content: message.content,
          seq: message.seq,
          createdAt: message.createdAt,
        },
      }
    }),
  })
})

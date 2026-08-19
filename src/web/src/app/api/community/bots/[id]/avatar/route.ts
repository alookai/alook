import { NextRequest } from "next/server"
import { queries, CACHE_REVALIDATE } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { handleBotAvatarUpload } from "@/lib/community/upload"
import { buildBotAvatarKey, botAvatarUrl } from "@/lib/community/storage"

// No ownership check — other members/DM peers need to see a bot's avatar.
//
// The URL never changes across re-uploads (deterministic key). Let the browser
// paint stale bytes while it revalidates the R2 ETag in the background, so a
// warm avatar never waits behind a network round trip.
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id
  if (!botId) return writeError("missing bot id", 400)

  const obj = await ctx.env.COMMUNITY_MEDIA.get(buildBotAvatarKey(botId))
  if (!obj) return writeError("not found", 404)

  const etag = obj.httpEtag
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_REVALIDATE } })
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": CACHE_REVALIDATE,
      ...(etag ? { ETag: etag } : {}),
    },
  })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id
  if (!botId) return writeError("missing bot id", 400)

  const db = getDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const result = await handleBotAvatarUpload(req, ctx.env, botId)
  if (!result.ok) return result.response

  const url = botAvatarUrl(botId)
  await queries.communityBot.updateBot(db, botId, ctx.userId, { image: url })

  return writeJSON({ url })
})

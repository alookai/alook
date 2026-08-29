import { NextRequest } from "next/server"
import { CACHE_REVALIDATE, createLogger, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
  buildUserAvatarKey,
  isOwnedUserAvatarObjectKey,
  userAvatarUrl,
} from "@/lib/community/storage"

const log = createLogger({ service: "community-user-avatar" })
const PRIVATE_NO_STORE = "private, no-store"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const userId = ctx.params?.userId
  if (!userId) return writeError("missing user id", 400)

  const state = await queries.user.getLiveHumanAvatarState(getDb(ctx.env.DB), userId)
  if (!state) return writeError("not found", 404)

  const legacy = state.avatarVersion === 0 && state.avatarObjectKey === null
  const versioned = state.avatarVersion > 0
    && state.avatarObjectKey !== null
    && isOwnedUserAvatarObjectKey(state.avatarObjectKey, userId)
  if (!legacy && !versioned) {
    log.warn("community_user_avatar_state_inconsistent", { stateKind: "invalid_pair" })
    return writeError("not found", 404)
  }

  let key = buildUserAvatarKey(userId)
  let cacheControl = CACHE_REVALIDATE
  if (versioned) {
    const requestedVersion = req.nextUrl.searchParams.get("v")
    if (requestedVersion !== String(state.avatarVersion)) {
      return new Response(null, {
        status: 307,
        headers: {
          Location: userAvatarUrl(userId, state.avatarVersion),
          "Cache-Control": PRIVATE_NO_STORE,
        },
      })
    }
    key = state.avatarObjectKey!
    cacheControl = ATTACHMENT_PRIVATE_IMMUTABLE_CACHE
  } else if (req.nextUrl.searchParams.has("v")) {
    return new Response(null, {
      status: 307,
      headers: { Location: userAvatarUrl(userId), "Cache-Control": PRIVATE_NO_STORE },
    })
  }

  const obj = await ctx.env.COMMUNITY_MEDIA.get(key)
  if (!obj) return writeError("not found", 404)

  const etag = obj.httpEtag
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } })
  }

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": cacheControl,
      ...(etag ? { ETag: etag } : {}),
    },
  })
})

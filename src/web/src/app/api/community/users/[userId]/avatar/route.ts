import { COMMUNITY_IMAGE_REVISION } from "@alook/shared"
import { createCommunityImageResponse } from "@/lib/community/image-processing"
import { withAuth } from "@/lib/middleware/auth-policy"
import { NextRequest } from "next/server"
import { CACHE_REVALIDATE, createLogger, queries } from "@alook/shared"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withPrivateMediaCache } from "@/lib/middleware/private-media-cache"
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

export const GET = withPrivateMediaCache(withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
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
    if (requestedVersion !== String(state.avatarVersion) || req.nextUrl.searchParams.get("image") !== String(COMMUNITY_IMAGE_REVISION)) {
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
  } else if (req.nextUrl.searchParams.get("v") !== "0" || req.nextUrl.searchParams.get("image") !== String(COMMUNITY_IMAGE_REVISION)) {
    return new Response(null, {
      status: 307,
      headers: { Location: userAvatarUrl(userId, 0), "Cache-Control": PRIVATE_NO_STORE },
    })
  }

  const obj = await ctx.env.COMMUNITY_MEDIA.get(key)
  if (!obj) return writeError("not found", 404)

  return createCommunityImageResponse({ request: req, env: ctx.env, source: obj, sourceKey: key, variant: "identity", cacheControl })
}))

import { COMMUNITY_IMAGE_REVISION } from "@alook/shared"
import { createCommunityImageResponse } from "@/lib/community/image-processing"
import { withAuth } from "@/lib/middleware/auth-policy"
import { NextRequest } from "next/server"
import { CACHE_REVALIDATE, createLogger, queries } from "@alook/shared"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withPrivateMediaCache } from "@/lib/middleware/private-media-cache"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { handleBotAvatarUpload } from "@/lib/community/upload"
import {
  ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
  buildBotAvatarKey,
  botAvatarUrl,
  isOwnedBotAvatarObjectKey,
} from "@/lib/community/storage"
import { persistUploadedBotAvatar } from "@/lib/community/bot-avatar-persistence"
import {
  ensureAvatarAliasPresent,
  scheduleAvatarMediaReconciliation,
} from "@/lib/community/avatar-media-reconciliation"
import { fanOutIdentityUpdate } from "@/lib/community/fanout"

const log = createLogger({ service: "community-bot-avatar-route" })
const PRIVATE_NO_STORE = "private, no-store"

export const GET = withPrivateMediaCache(withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id
  if (!botId) return writeError("missing bot id", 400)

  const db = getDb(ctx.env.DB)
  const state = await queries.communityBot.getLiveBotAvatar(db, botId)
  if (!state || state.image !== botAvatarUrl(botId)) return writeError("not found", 404)

  const legacy = state.avatarVersion === 0 && state.avatarObjectKey === null
  const versioned = state.avatarVersion > 0
    && state.avatarObjectKey !== null
    && isOwnedBotAvatarObjectKey(state.avatarObjectKey, botId)
  if (!legacy && !versioned) {
    log.warn("community_bot_avatar_state_inconsistent", { stateKind: "invalid_pair" })
    return writeError("not found", 404)
  }

  let key = buildBotAvatarKey(botId)
  let cacheControl = CACHE_REVALIDATE
  if (versioned) {
    if (req.nextUrl.searchParams.get("v") !== String(state.avatarVersion) || req.nextUrl.searchParams.get("image") !== String(COMMUNITY_IMAGE_REVISION)) {
      return new Response(null, {
        status: 307,
        headers: {
          Location: botAvatarUrl(botId, state.avatarVersion),
          "Cache-Control": PRIVATE_NO_STORE,
        },
      })
    }
    key = state.avatarObjectKey!
    cacheControl = ATTACHMENT_PRIVATE_IMMUTABLE_CACHE
  } else if (req.nextUrl.searchParams.get("v") !== "0" || req.nextUrl.searchParams.get("image") !== String(COMMUNITY_IMAGE_REVISION)) {
    return new Response(null, {
      status: 307,
      headers: { Location: botAvatarUrl(botId, 0), "Cache-Control": PRIVATE_NO_STORE },
    })
  }

  const obj = await ctx.env.COMMUNITY_MEDIA.get(key)
  if (!obj) return writeError("not found", 404)
  return createCommunityImageResponse({ request: req, env: ctx.env, source: obj, sourceKey: key, variant: "identity", cacheControl })
}))

export const POST = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id
  if (!botId) return writeError("missing bot id", 400)

  const db = getDb(ctx.env.DB)
  if (!(await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId))) {
    return writeError("bot not found", 404)
  }

  const upload = await handleBotAvatarUpload(req, ctx.env, botId)
  if (!upload.ok) return upload.response
  const persisted = await persistUploadedBotAvatar(db, ctx.env.COMMUNITY_MEDIA, {
    botId,
    ownerId: ctx.userId,
    objectKey: upload.key,
  })
  if (persisted.kind === "not_found") return writeError("bot not found", 404)
  if (persisted.kind === "failed") return writeError("internal error", 500)

  const subject = { kind: "bot" as const, id: botId }
  if (!(await ensureAvatarAliasPresent(db, ctx.env.COMMUNITY_MEDIA, subject))) {
    log.warn("community_bot_avatar_alias_unavailable", { phase: "before_response" })
    return writeError("internal error", 500)
  }
  void scheduleAvatarMediaReconciliation(db, ctx.env.COMMUNITY_MEDIA, {
    subject,
    candidates: [persisted.previousObjectKey, persisted.avatarObjectKey],
  })

  const url = botAvatarUrl(botId, persisted.avatarVersion)
  void fanOutIdentityUpdate(botId, url, persisted.avatarVersion, ctx.userId)
  return writeJSON({ url, avatarVersion: persisted.avatarVersion })
})

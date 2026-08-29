import { NextRequest } from "next/server"
import { CACHE_REVALIDATE, createLogger, queries } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
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

export const GET = withAuth(async (req: NextRequest, ctx) => {
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
    if (req.nextUrl.searchParams.get("v") !== String(state.avatarVersion)) {
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
  } else if (req.nextUrl.searchParams.has("v")) {
    return new Response(null, {
      status: 307,
      headers: { Location: botAvatarUrl(botId), "Cache-Control": PRIVATE_NO_STORE },
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

export const POST = withAuth(async (req: NextRequest, ctx) => {
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

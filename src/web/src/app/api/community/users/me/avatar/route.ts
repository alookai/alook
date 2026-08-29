import { NextRequest, NextResponse } from "next/server"
import { createLogger, queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { handleBotAvatarUpload, handleUserAvatarUpload } from "@/lib/community/upload"
import { botAvatarUrl, userAvatarUrl } from "@/lib/community/storage"
import { persistUploadedBotAvatar } from "@/lib/community/bot-avatar-persistence"
import {
  cleanupAvatarCandidate,
  ensureAvatarAliasPresent,
  scheduleAvatarMediaReconciliation,
} from "@/lib/community/avatar-media-reconciliation"
import { fanOutIdentityUpdate } from "@/lib/community/fanout"

const log = createLogger({ service: "community-self-avatar" })

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const userId = ctx.actor.userId
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "bot") {
    if (!(await queries.communityBot.getBotOwnedBy(db, userId, ctx.actor.ownerUserId))) {
      return writeError("bot not found", 404)
    }

    const upload = await handleBotAvatarUpload(req, ctx.env, userId)
    if (!upload.ok) return upload.response
    const persisted = await persistUploadedBotAvatar(db, ctx.env.COMMUNITY_MEDIA, {
      botId: userId,
      ownerId: ctx.actor.ownerUserId,
      objectKey: upload.key,
    })
    if (persisted.kind === "not_found") return writeError("bot not found", 404)
    if (persisted.kind === "failed") return writeError("internal error", 500)

    const subject = { kind: "bot" as const, id: userId }
    if (!(await ensureAvatarAliasPresent(db, ctx.env.COMMUNITY_MEDIA, subject))) {
      log.warn("community_bot_avatar_alias_unavailable", { phase: "before_response" })
      return writeError("internal error", 500)
    }
    void scheduleAvatarMediaReconciliation(db, ctx.env.COMMUNITY_MEDIA, {
      subject,
      candidates: [persisted.previousObjectKey, persisted.avatarObjectKey],
    })
    const url = botAvatarUrl(userId, persisted.avatarVersion)
    void fanOutIdentityUpdate(
      userId,
      url,
      persisted.avatarVersion,
      ctx.actor.ownerUserId,
    )
    return writeJSON({ url, avatarVersion: persisted.avatarVersion })
  }

  const upload = await handleUserAvatarUpload(req, ctx.env, userId)
  if (!upload.ok) return upload.response

  let published: Awaited<ReturnType<typeof queries.user.publishHumanAvatar>>
  try {
    published = await queries.user.publishHumanAvatar(db, userId, {
      objectKey: upload.key,
      stableUrl: userAvatarUrl(userId),
    })
  } catch (error) {
    try {
      const current = await queries.user.getLiveHumanAvatarState(db, userId)
      if (current?.avatarObjectKey === upload.key && current.avatarVersion > 0) {
        published = { previous: current, current }
      } else {
        await cleanupAvatarCandidate(
          db,
          ctx.env.COMMUNITY_MEDIA,
          { kind: "human", id: userId },
          upload.key,
        )
        log.warn("community_user_avatar_publish_failed", {
          phase: "unknown_noncurrent",
          errorCategory: error instanceof Error ? error.name : "NonError",
        })
        return writeError("internal error", 500)
      }
    } catch (verificationError) {
      log.warn("community_user_avatar_publish_verification_failed", {
        phase: "unknown_commit",
        persistErrorCategory: error instanceof Error ? error.name : "NonError",
        verificationErrorCategory:
          verificationError instanceof Error ? verificationError.name : "NonError",
      })
      return writeError("internal error", 500)
    }
  }

  if (!published) {
    await cleanupAvatarCandidate(
      db,
      ctx.env.COMMUNITY_MEDIA,
      { kind: "human", id: userId },
      upload.key,
    )
    return writeError("user not found", 404)
  }

  const subject = { kind: "human" as const, id: userId }
  if (!(await ensureAvatarAliasPresent(db, ctx.env.COMMUNITY_MEDIA, subject))) {
    log.warn("community_user_avatar_alias_unavailable", { phase: "before_response" })
    return writeError("internal error", 500)
  }

  const avatarVersion = published.current.avatarVersion
  const url = userAvatarUrl(userId, avatarVersion)
  let authHeaders: Headers | null = null
  try {
    const auth = createAuth(ctx.env)
    const authResult = (await auth.api.updateUser({
      body: { image: userAvatarUrl(userId) },
      headers: req.headers,
      returnHeaders: true,
    })) as { headers: Headers }
    authHeaders = authResult.headers
  } catch (error) {
    log.warn("community_user_avatar_session_refresh_failed", {
      phase: "after_publish",
      errorCategory: error instanceof Error ? error.name : "NonError",
    })
  }

  void scheduleAvatarMediaReconciliation(db, ctx.env.COMMUNITY_MEDIA, {
    subject,
    candidates: [published.previous.avatarObjectKey, upload.key],
  })
  void fanOutIdentityUpdate(userId, url, avatarVersion)

  const res = writeJSON({ url, avatarVersion })
  const setCookies = authHeaders?.getSetCookie() ?? []
  if (setCookies.length === 0) return res

  const response = new NextResponse(res.body, res)
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie)
  return response
})

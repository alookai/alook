import { NextRequest, NextResponse } from "next/server"
import {
  queries,
  MAX_PROFILE_ABOUT_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MAX_EMOJI_BYTES,
  BANNER_COLOR_REGEX,
  WS_EVENTS,
  validateCommunityName,
  withD1Retry,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { fanOutStatusUpdate, fanOutToServerMembers } from "@/lib/community/fanout"
import { canonicalUserImage } from "@/lib/community/storage"

export const GET = withCommunityActor(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId
  const [profile, viewer] = await Promise.all([
    withD1Retry(
      () => queries.communityUserProfile.getProfile(db, userId),
      { route: "community/profile:self-profile" }
    ),
    withD1Retry(
      () => queries.user.getUserSelf(db, userId),
      { route: "community/profile:self-user" }
    ),
  ])
  return writeJSON({
    id: userId,
    aboutMe: profile?.aboutMe ?? "",
    avatar: viewer
      ? canonicalUserImage(viewer.id, viewer.image, viewer.avatarVersion) ?? ""
      : "",
    avatarVersion: viewer?.avatarVersion ?? 0,
    bannerColor: profile?.bannerColor ?? null,
    discriminator: viewer?.discriminator ?? "0000",
    name: viewer?.name ?? "",
    statusEmoji: profile?.statusEmoji ?? null,
    statusText: profile?.statusText ?? "",
  })
})

export const PATCH = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId

  let body: {
    name?: string
    aboutMe?: string
    bannerColor?: string | null
    statusEmoji?: string | null
    statusText?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (ctx.actor.kind === "bot") {
    const forbidden = ["name", "bannerColor", "statusEmoji", "statusText"] as const
    if (forbidden.some((field) => body[field] !== undefined)) {
      return writeError("forbidden: bots may only update aboutMe", 403)
    }
  }

  if (
    body.aboutMe === undefined &&
    body.bannerColor === undefined &&
    body.name === undefined &&
    body.statusEmoji === undefined &&
    body.statusText === undefined
  ) {
    return writeError("no changes provided", 400)
  }

  // Set only when a rename actually happens — carries the Set-Cookie
  // headers `auth.api.updateUser` mints so they can be forwarded on the
  // final response (see the return below).
  let renameCookieHeaders: Headers | undefined

  if (body.name !== undefined && ctx.actor.kind === "human") {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    // Rejects empty, over-length, and names with `#`/`@`/line breaks — the last
    // keeps `@Name#dddd` mention grammar unambiguous. The auth `update.before`
    // hook sanitizes as a backstop for the raw `/update-user` path; this 400 is
    // the clean-UX message for the in-app rename.
    const nameCheck = validateCommunityName(trimmed)
    if (!nameCheck.ok) return writeError(nameCheck.reason, 400)
    // Goes through Better-Auth's own `/update-user` rather than a raw
    // Drizzle write — it updates the DB row AND re-signs the
    // `session_token`/`session_data` cookies in the same call, so a
    // refresh right after renaming doesn't read a stale cached session
    // (the bug this fixes: cookieCache — auth.ts's `session.cookieCache`,
    // 5min TTL — previously never got invalidated by a raw DB write).
    const auth = createAuth(ctx.env)
    const result = (await auth.api.updateUser({
      body: { name: trimmed },
      headers: req.headers,
      returnHeaders: true,
    })) as { headers: Headers }
    renameCookieHeaders = result.headers

    // Broadcast the new name to every server the user belongs to, so open
    // member lists update without a refresh (previously nothing fired
    // MEMBER_UPDATE for a self-rename — only role changes did).
    const serverIds = await queries.communityMember.listMemberServerIds(db, userId)
    if (serverIds.length > 0) {
      const memberships = await queries.communityMember.getMemberships(db, userId, serverIds)
      for (const membership of memberships) {
        fanOutToServerMembers(membership.serverId, {
          type: WS_EVENTS.MEMBER_UPDATE,
          serverId: membership.serverId,
          memberId: membership.id,
          userId,
          changes: { nickname: trimmed },
        })
      }
    }
  }

  const data: {
    aboutMe?: string
    bannerColor?: string | null
    statusEmoji?: string | null
    statusText?: string | null
  } = {}
  if (body.aboutMe !== undefined) {
    if (typeof body.aboutMe !== "string") return writeError("aboutMe must be a string", 400)
    if (body.aboutMe.length > MAX_PROFILE_ABOUT_LENGTH) {
      return writeError(`aboutMe must be ≤ ${MAX_PROFILE_ABOUT_LENGTH} characters`, 400)
    }
    data.aboutMe = body.aboutMe
  }
  if (body.bannerColor !== undefined) {
    if (body.bannerColor !== null) {
      // Hex-only allowlist prevents CSS injection if the value is ever
      // rendered into a style attribute.
      if (typeof body.bannerColor !== "string" || !BANNER_COLOR_REGEX.test(body.bannerColor.trim())) {
        return writeError("bannerColor must be a hex color like #aabbcc", 400)
      }
      data.bannerColor = body.bannerColor.trim()
    } else {
      data.bannerColor = null
    }
  }
  if (body.statusEmoji !== undefined) {
    if (body.statusEmoji !== null) {
      if (typeof body.statusEmoji !== "string") return writeError("statusEmoji must be a string", 400)
      if (Buffer.byteLength(body.statusEmoji, "utf8") > MAX_EMOJI_BYTES) {
        return writeError(`statusEmoji must be ≤ ${MAX_EMOJI_BYTES} bytes`, 400)
      }
      data.statusEmoji = body.statusEmoji
    } else {
      data.statusEmoji = null
    }
  }
  if (body.statusText !== undefined) {
    if (body.statusText !== null) {
      if (typeof body.statusText !== "string") return writeError("statusText must be a string", 400)
      if (body.statusText.length > MAX_STATUS_TEXT_LENGTH) {
        return writeError(`statusText must be ≤ ${MAX_STATUS_TEXT_LENGTH} characters`, 400)
      }
      data.statusText = body.statusText
    } else {
      data.statusText = null
    }
  }

  let updated: {
    aboutMe: string | null
    bannerColor: string | null
    statusEmoji: string | null
    statusText: string | null
  } | null = null
  if (
    data.aboutMe !== undefined ||
    data.bannerColor !== undefined ||
    data.statusEmoji !== undefined ||
    data.statusText !== undefined
  ) {
    updated = await queries.communityUserProfile.updateProfile(db, userId, data)
  }

  // Fan out only when a status field was actually part of this patch — a
  // plain aboutMe-only save must not trigger a broadcast.
  if (data.statusEmoji !== undefined || data.statusText !== undefined) {
    await fanOutStatusUpdate(
      userId,
      updated?.statusEmoji ?? null,
      updated?.statusText ?? null,
    )
  }

  // Normalise the response shape — same as GET — so callers don't see
  // `userId` leak through on PATCH.
  const res = writeJSON({
    aboutMe: updated?.aboutMe ?? "",
    bannerColor: updated?.bannerColor ?? null,
    statusEmoji: updated?.statusEmoji ?? null,
    statusText: updated?.statusText ?? "",
  })

  // Forward the re-signed session cookies from a rename so the browser
  // picks up the new name immediately — `withAuth` also forwards its own
  // `getSession` Set-Cookie separately; both can land on the same response
  // (harmless — the browser applies the last Set-Cookie for a given name).
  if (renameCookieHeaders) {
    const setCookies = renameCookieHeaders.getSetCookie()
    if (setCookies.length > 0) {
      const mutableRes = new NextResponse(res.body, res)
      for (const cookie of setCookies) {
        mutableRes.headers.append("Set-Cookie", cookie)
      }
      return mutableRes
    }
  }

  return res
})

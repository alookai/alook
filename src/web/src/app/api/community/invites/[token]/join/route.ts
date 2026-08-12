import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, ROLES, WS_EVENTS, isUniqueConstraintError } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { fanOutToServerMembers, broadcastToUserSafe } from "@/lib/community/fanout"

/**
 * POST /api/community/invites/[token]/join — the unified join route (plan §4
 * FOLD, §9 phase 4). Serves both a human (session/al_) and a bot (crk_) via
 * `withCommunityActor`; the old /agent/joinServer folds in here (batch1
 * cab6c3e7 did the same fold). Two things branch on `actor.kind`:
 *   1. owner-gate — a bot may only consume an invite created by ITS OWN owner
 *      (checked BEFORE useInvite, so a foreign/dead-creator invite is never
 *      consumed by a rejected attempt); a human joins any valid invite.
 *   2. owner broadcast — the bot's owner isn't necessarily a member of the
 *      joined server, so fanOutToServerMembers won't reach them; send the
 *      MEMBER_JOIN directly (dedup-safe on re-delivery).
 * Response is a superset (Fork C): `{ member, serverId, server }` — the human
 * web client reads member/serverId; the bot's daemon projects `server`
 * ({id,name}). `invite.createdBy === null` (creator account gone) is the
 * generic "invalid/expired" case, distinct from an owner mismatch.
 */
export const POST = withCommunityActor(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("invite token is required", 400)

  const db = getDb(ctx.env.DB)
  const actor = ctx.actor

  // Bot owner-gate — runs BEFORE useInvite so a rejected attempt never consumes
  // the invite. A human skips this and may join any valid invite.
  if (actor.kind === "bot") {
    const invite = await queries.communityInvite.getInviteByToken(db, token)
    if (!invite || invite.createdBy === null) {
      return writeError("Invalid or expired invite", 400)
    }
    if (invite.createdBy !== actor.ownerUserId) {
      // Preserve the bot CLI's actionable hint (the /agent/joinServer contract).
      return writeJSON(
        {
          error: "This invite was not created by your owner — refusing to join.",
          hint: "Ask your owner to send an invite link they created themselves.",
        },
        403,
      )
    }
  }

  let result: Awaited<ReturnType<typeof queries.communityInvite.useInvite>>
  try {
    result = await queries.communityInvite.useInvite(db, token, actor.userId)
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      return writeError("Already a member", 400)
    }
    throw err
  }

  if (!result) {
    return writeError("Invalid or expired invite", 400)
  }


  const memberEvent: CommunityMemberJoin = {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: result.invite.serverId,
    member: {
      id: result.member.id,
      userId: result.member.userId,
      name: result.member.userName ?? "",
      discriminator: result.member.discriminator ?? undefined,
      avatar: result.member.userImage ?? undefined,
      role: result.member.role ?? ROLES.MEMBER,
      joinedAt: result.member.joinedAt,
    },
  }

  fanOutToServerMembers(
    result.invite.serverId,
    memberEvent,
    { excludeUserId: actor.userId },
  )

  // A bot's OWNER isn't necessarily a member of the joined server, so the
  // member-scoped fan-out above never reaches them; send the same event
  // directly so their bot-list / server-rail updates without a refresh.
  // patchCacheJoin dedupes by userId, so double-delivery (owner also a member)
  // is a no-op.
  if (actor.kind === "bot") {
    broadcastToUserSafe(actor.ownerUserId, memberEvent)
  }

  // Superset response: the human web client reads member/serverId; the bot's
  // daemon reads `server` and projects it to the canonical handle. `server` is
  // populated only for a bot — the human path already has serverId and would
  // otherwise pay an extra getServer round-trip for a field it ignores (the
  // superset is about a unified SHAPE, not forcing identical queries).
  let server: { id: string; name: string; discriminator: string } | undefined
  if (actor.kind === "bot") {
    const row = await queries.communityServer.getServer(db, result.invite.serverId)
    server = row ? { id: row.id, name: row.name, discriminator: row.discriminator } : undefined
  }
  return writeJSON({
    member: result.member,
    serverId: result.invite.serverId,
    server,
  })
})

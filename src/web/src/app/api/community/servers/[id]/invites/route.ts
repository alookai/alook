import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MIN_INVITE_MAX_USES,
  MAX_INVITE_MAX_USES,
  MAX_INVITE_EXPIRY_DAYS,
  MAX_ACTIVE_INVITES_PER_SERVER,
  WS_EVENTS,
} from "@alook/shared"
import type { CommunityInviteCreate } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireServerMember } from "@/lib/community/permissions"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("server id is required", 400)

  const db = getDb(ctx.env.DB)
  // Any member can see the invite list.
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const invites = await queries.communityInvite.listServerInvites(db, serverId)
  return writeJSON({ invites })
})

export const POST = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("server id is required", 400)

  const db = getDb(ctx.env.DB)
  // Any member can create an invite. Growth is bounded by
  // MAX_ACTIVE_INVITES_PER_SERVER + expiry + maxUses, not by role.
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { maxUses?: number; expiresAt?: string } = {}
  try {
    body = await req.json()
  } catch {
    // empty body is fine — all fields are optional
  }

  if (body.maxUses !== undefined) {
    if (
      !Number.isInteger(body.maxUses) ||
      body.maxUses < MIN_INVITE_MAX_USES ||
      body.maxUses > MAX_INVITE_MAX_USES
    ) {
      return writeError(
        `maxUses must be an integer between ${MIN_INVITE_MAX_USES} and ${MAX_INVITE_MAX_USES}`,
        400,
      )
    }
  }
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== "string") {
      return writeError("expiresAt must be an ISO date string", 400)
    }
    const expiry = new Date(body.expiresAt)
    const now = Date.now()
    const maxExpiry = now + MAX_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    const ts = expiry.getTime()
    if (Number.isNaN(ts) || ts <= now || ts > maxExpiry) {
      return writeError(
        `expiresAt must be a future ISO date within ${MAX_INVITE_EXPIRY_DAYS} days`,
        400,
      )
    }
  }

  // Cap active invites per server to bound token-table growth + enumeration risk.
  const existing = await queries.communityInvite.listServerInvites(db, serverId)
  if (existing.length >= MAX_ACTIVE_INVITES_PER_SERVER) {
    return writeError(
      `server has reached the active invite cap (${MAX_ACTIVE_INVITES_PER_SERVER}); revoke an existing invite first`,
      409,
    )
  }

  const invite = await queries.communityInvite.createInvite(db, {
    serverId,
    createdBy: ctx.userId,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt,
  })

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "invite_create",
    targetType: "invite",
    targetId: invite.id,
  })

  const event: CommunityInviteCreate = {
    type: WS_EVENTS.INVITE_CREATE,
    serverId,
    invite: {
      id: invite.id,
      token: invite.token,
      maxUses: invite.maxUses,
      uses: invite.uses,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    },
  }

  fanOutToServerMembers(serverId, event, { excludeUserId: ctx.userId })

  return writeJSON({ invite }, 201)
})

import { NextRequest } from "next/server"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  WS_EVENTS,
  isForum,
  isThread,
  DM_SERVER,
  formatHandle,
  parseRef,
  withD1Retry,
} from "@alook/shared"
import type {
  CommunityCliChannelMemberResult as ChannelMemberResult,
  CommunityCliServerMember as ServerMember,
} from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"
import { resolveTargetForMember } from "@/lib/community/resolve-ref"
import { mapMemberForApi } from "@/lib/community/member-payload"
import { fetchOnlineUserIds, toMemberStatus } from "@/lib/community/member-presence"

// A bot addresses by ref-in-query (`?ref=`, the folded `channelMember` verb);
// the path `[id]` is then the `resolve` placeholder (a ref carries `/`). A
// human/web caller puts the real channelId in the path.
const REF_PLACEHOLDER_ID = "resolve"

/**
 * GET /api/community/channels/[id]/members — the canonical "who is in this
 * channel" door. Dual-actor (route/disc trunk — folds the `channelMember` verb):
 *   - human/web (id-in-path) → the FULL resolved audience via mapMemberForApi:
 *     each row carries role / source / isCreator for the drawer + manage dialog.
 *   - bot/CLI (ref-in-query) → the lean `ChannelMemberResult` the folded
 *     `channelMember` verb returns: `{ visibility, members? , hint? }` — a public
 *     channel yields a hint (use `server member`), a private one / thread yields
 *     the roster as `{ handle, role }`. DM refs are channel-scoped → 400.
 * Response FORM forks by the credential actor (Aigneis ②, never a field); the
 * ①-C existence mask is uniform (bot ref → member-scoped resolve → 404 before
 * any enumeration; human id → requireChannelAccess 403/404). Any caller with
 * access may read.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "bot") {
    return handleBotChannelMember(db, ctx.env, ctx.actor.userId, req)
  }

  const channelId = ctx.params?.id
  if (!channelId || channelId === REF_PLACEHOLDER_ID) return writeError("missing channel id", 400)

  const access = await requireChannelAccess(db, channelId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const userId = ctx.actor.userId

  const { anchor, channel } = access.value

  // Thread: the NOTIFY dimension. The panel == the participant set (not the
  // access audience), so a public thread lists only its participants, never
  // the whole server. The row's `isCreator` locks the UNIT's own author
  // (`channel.creatorId`), NOT the access anchor. NOTE: the live /c UI reads
  // `/participants` for these units; this branch is API/agent parity so a
  // direct GET of a thread's `/members` agrees.
  if (isThread(channel.type)) {
    const participants = await queries.communityThread.listThreadParticipants(db, channelId)
    const userIds = participants.map((p) => p.userId)
    const rows = await queries.communityMember.getMembersByUserIds(db, channel.serverId, userIds)
    const rowByUser = new Map(rows.map((r) => [r.userId, r]))
    const members = participants
      .map((p) => {
        const row = rowByUser.get(p.userId)
        if (!row) return null
        return mapMemberForApi(row, userId, {
          isCreator: p.userId === channel.creatorId,
          source: p.source,
        })
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
    return writeJSON({ members })
  }

  // Channel / forum: the ACCESS dimension. Resolve the audience (public → all
  // server members; private → own roster ∪ creator). The anchor IS the roster
  // for these top-level units, so the roster creator is `anchor.creatorId`.
  const scopeMembers = await withD1Retry(
    () => queries.communityMembersResolver.resolveScopeMembers(db, {
      scope: isForum(channel.type) ? "forum" : "channel",
      scopeId: channelId,
    }),
    { route: "community/channel-members:resolve-scope" },
  )
  const rows = await queries.communityMember.getMembersByUserIds(
    db,
    anchor.serverId,
    scopeMembers.map((m) => m.userId),
  )
  const rowByUser = new Map(rows.map((r) => [r.userId, r]))

  // `resolveScopeMembers` order is the source of truth for membership; hydrate
  // display via the server-member rows (soft-deleted users drop out — expected).
  const members = scopeMembers
    .map((sm) => {
      const row = rowByUser.get(sm.userId)
      if (!row) return null
      return mapMemberForApi(row, userId, {
        isCreator: sm.userId === anchor.creatorId,
        source: sm.source,
      })
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)

  return writeJSON({ members })
})

/**
 * Add a member to a private ACCESS unit — a top-level text channel OR a forum
 * (both own their roster; a forum resolves access like a channel). ANY current
 * member (or the creator) may add — passing `requireChannelAccess` for a private
 * unit already means the caller is the creator or an added member (admins have
 * no implicit access). The target must be an existing server member. Threads
 * are rejected — they're the NOTIFY dimension, inherit the parent's roster,
 * and take PARTICIPANTS (via the participants route), not access members.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  // Human-only management op (add a member to a private access unit). There is
  // NO bot add-member verb, and this is a capability boundary (not an
  // existence-mask concern), so a bot is a plain 403, not an opaque 404.
  const rejected = rejectBot(ctx.actor)
  if (rejected) return rejected

  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)
  const userId = ctx.actor.userId

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, userId)
  if (!access.ok) return writeError(access.error, access.status)

  const channel = access.value.channel
  // Threads are the NOTIFY dimension — they inherit their parent channel/
  // forum's access roster and store their own set in the participant table.
  // You add PARTICIPANTS to them (via the participants route), not access
  // members. A thread carries a `parentMessageId`.
  if (isThread(channel.type) || channel.parentMessageId) {
    return writeError("threads inherit their parent's members — add participants instead", 400)
  }
  // `isPrivate` from requireChannelAccess reflects the category. A public
  // channel/forum has no explicit roster (everyone can access it).
  if (!access.value.isPrivate) {
    return writeError("channel is not in a private category", 400)
  }

  let body: { userId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  const targetUserId = body.userId
  if (!targetUserId || typeof targetUserId !== "string") {
    return writeError("userId is required", 400)
  }

  const targetMember = await queries.communityMember.getMember(db, channel.serverId, targetUserId)
  if (!targetMember) return writeError("user is not a member of this server", 400)

  await queries.communityChannel.createChannelMember(db, {
    channelId,
    userId: targetUserId,
    addedBy: userId,
  })

  const event = {
    type: WS_EVENTS.CHANNEL_MEMBER_ADD,
    serverId: channel.serverId,
    channelId,
    userId: targetUserId,
  } as const
  const recipients = await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
  await Promise.all([...new Set([...recipients, targetUserId])].map((uid) => broadcastToUserSafe(uid, event)))

  logAudit(db, {
    serverId: channel.serverId,
    actorId: userId,
    action: "channel_member_add",
    targetType: "channel",
    targetId: channelId,
    changes: JSON.stringify({ userId: targetUserId }),
  })

  return writeJSON({ ok: true }, 201)
})

/**
 * Bot arm — the folded `channelMember` verb (`alook channel member --channel
 * <ref>`). ref-in-query → member-scoped resolve (404-before-enumeration, ①-C) →
 * the lean `ChannelMemberResult`. Behavior byte-identical to the old flat
 * `channelMember` route: DM refs are channel-scoped → 400; a thread returns its
 * participant roster (always private on the wire); a public top-level channel/
 * forum returns a `{ visibility: "public", hint }` (no enumeration — point the
 * agent at `server member`); a private one returns `{ visibility: "private",
 * members }` from the same audience the fan-out uses. Members carry `online` +
 * `status` (bulk presence read, never per-member); `hasMore: false` — a
 * channel/thread roster is membership-bounded and returned whole, wire shape
 * kept uniform with `server member`'s pagination.
 */
async function handleBotChannelMember(
  db: ReturnType<typeof getDb>,
  env: Env,
  botUserId: string,
  req: NextRequest,
) {
  const ref = req.nextUrl.searchParams.get("ref")
  if (!ref) return writeError("channel ref required", 400)

  // Reject DM refs up front: an un-opened DM would otherwise trip
  // resolveTargetForMember's 404 "dm not found" before this channel-scoped 400.
  try {
    const p = parseRef(ref)
    if (p.server === DM_SERVER) {
      return writeError("channel member is channel-scoped — DM refs are not supported", 400)
    }
  } catch {
    // Fall through — resolveTargetForMember returns the canonical 400.
  }

  // Member-scoped resolve (unreachable → 404 before enumeration, ①-C). No
  // create-if-missing — a roster read is pure addressing.
  const resolved = await resolveTargetForMember(db, botUserId, ref, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return writeError(resolved.message, resolved.error)
  if (resolved.kind === "dm") {
    return writeError("channel member is channel-scoped — DM refs are not supported", 400)
  }

  const channelId = resolved.channelId
  const access = await requireChannelAccess(db, channelId, botUserId)
  if (!access.ok) return writeError(access.error, access.status)

  const { channel, isPrivate } = access.value

  // Thread: the NOTIFY dimension — roster is the participant set, always private
  // on the wire regardless of the parent's public/private state.
  if (isThread(channel.type)) {
    const userIds = await queries.communityThread.listThreadParticipantUserIds(db, channelId)
    const members = await hydrateBotMembers(db, env, channel.serverId, userIds)
    return writeJSON({ visibility: "private", members, hasMore: false })
  }

  if (!isPrivate) {
    const server = await queries.communityServer.getServer(db, channel.serverId)
    const serverName = server?.name ?? channel.serverId
    const hint = `This channel is public. Use \`alook server member --server ${serverName}\` to list who can see it.`
    return writeJSON({ visibility: "public", hint })
  }

  const scoped = await withD1Retry(
    () => queries.communityMembersResolver.resolveScopeMembers(db, { scope: "channel", scopeId: channelId }),
    { route: "community/channel-members:resolve-scope" },
  )
  const members = await hydrateBotMembers(db, env, channel.serverId, scoped.map((s) => s.userId))
  return writeJSON({ visibility: "private", members, hasMore: false })
}

/**
 * Hydrate a user id list into the lean `ServerMember[]` the bot contract uses
 * (handle + role + online + status) — mirrors the flat channelMember route's
 * `hydrateMembers`. Soft-deleted / missing-member-row users drop out via the
 * inner join. Presence is one bulk read over the resolved (bounded) roster —
 * never per-member.
 */
async function hydrateBotMembers(
  db: ReturnType<typeof getDb>,
  env: Env,
  serverId: string,
  userIds: string[],
): Promise<ServerMember[]> {
  if (userIds.length === 0) return []
  const rows = await queries.communityMember.getMembersByUserIds(db, serverId, userIds)
  const onlineSet = await fetchOnlineUserIds(env, rows.map((r) => r.userId), serverId)
  return rows.map((r) => ({
    handle: formatHandle(r.userName ?? "", r.discriminator ?? "0000"),
    role: r.role ?? "member",
    online: onlineSet.has(r.userId),
    status: toMemberStatus(r),
  }))
}

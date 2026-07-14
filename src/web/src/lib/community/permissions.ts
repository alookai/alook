import { queries, canManageServer, canSeePrivateChannel } from "@alook/shared"
import type { Database } from "@alook/shared"

type PermissionError =
  | { ok: false; status: 401 | 403 | 404; error: string }

type Ok<T> = { ok: true; value: T }
export type Result<T> = Ok<T> | PermissionError

const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
const err = (status: 401 | 403 | 404, error: string): PermissionError => ({ ok: false, status, error })

/** Verify the caller is a member of the server. Returns the member row or an error. */
export async function requireServerMember(
  db: Database,
  serverId: string,
  userId: string,
): Promise<Result<Awaited<ReturnType<typeof queries.communityMember.getMember>>>> {
  const member = await queries.communityMember.getMember(db, serverId, userId)
  if (!member) return err(403, "not a member of this server")
  return ok(member)
}

/** Verify the caller is owner/admin of the server. */
export async function requireServerAdmin(
  db: Database,
  serverId: string,
  userId: string,
): Promise<Result<Awaited<ReturnType<typeof queries.communityMember.getMember>>>> {
  const member = await queries.communityMember.getMember(db, serverId, userId)
  if (!member) return err(403, "not a member of this server")
  if (!canManageServer(member.role)) return err(403, "admin permission required")
  return ok(member)
}

/**
 * Verify the caller may READ/POST in a channel; returns the channel row.
 *
 * The read/post gate for every message-scoped route (messages, pins,
 * reactions, uploads, read-state, threads, media, agent). Private-channel
 * visibility is enforced inside `getChannelForMember` itself (scope-first, per
 * AGENTS.md): it returns null when the caller can't see a channel in a private
 * category (or its thread), so this stays a thin wrapper and every existing
 * caller inherits the gating. Routes that need `canManage` (edit/delete, member
 * management) call `requireChannelAccess` directly.
 */
export async function requireChannelMember(
  db: Database,
  channelId: string,
  userId: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof queries.communityChannel.getChannelForMember>>>>> {
  const channel = await queries.communityChannel.getChannelForMember(db, channelId, userId)
  if (!channel) return err(403, "forbidden")
  return ok(channel)
}

type ChannelAccessContext = NonNullable<
  Awaited<ReturnType<typeof queries.communityChannel.resolveChannelAccessContext>>
>

export type ChannelAccess = {
  channel: ChannelAccessContext["channel"]
  anchor: ChannelAccessContext["anchor"]
  member: { role: string | null }
  canManage: boolean
  isCreator: boolean
  isPrivate: boolean
}

/**
 * Single-source-of-truth channel access gate. Resolves in one context query
 * (target + anchor + category privacy + member role + channel-member flag),
 * then applies the rule:
 *   - not a server member → 403
 *   - public/uncategorized → access; canManage only for admins
 *   - private → access iff creator or added member (admins have NO implicit
 *     content access); canManage iff admin (who can see it) or the unit creator
 * Threads inherit their parent anchor's audience (the context query climbs
 * `parentChannelId`); a forum post is its own access unit (roster on the post).
 *
 * Because access now requires membership/creator even for admins, an admin who
 * isn't in a private channel gets a 403 here — so `canManage` for an admin is
 * only reachable once they can see the channel. Out-of-channel admin management
 * lives on admin-gated routes / the future Browse Channels surface, not here.
 */
export async function requireChannelAccess(
  db: Database,
  channelId: string,
  userId: string,
): Promise<Result<ChannelAccess>> {
  const ctx = await queries.communityChannel.resolveChannelAccessContext(db, channelId, userId)
  if (!ctx) return err(403, "forbidden")

  const isAdmin = canManageServer(ctx.role)
  // `ctx.isCreator` is the roster-anchor creator (a post's OWN creator, else the
  // channel/thread anchor's) — NOT `ctx.anchor.creatorId`, which for a post is
  // the forum's creator.
  const isCreator = ctx.isCreator

  // Visibility: public → any server member; private → creator or added member
  // (canSeePrivateChannel; admins are NOT auto-granted). Manage: admin (who
  // passed the access gate) or the unit creator.
  const hasAccess = ctx.isPrivate
    ? canSeePrivateChannel({ isCreator, isChannelMember: ctx.isChannelMember })
    : true
  const canManage = isAdmin || (ctx.isPrivate && isCreator)

  if (!hasAccess) return err(403, "forbidden")
  return ok({
    channel: ctx.channel,
    anchor: ctx.anchor,
    member: { role: ctx.role },
    canManage,
    isCreator,
    isPrivate: ctx.isPrivate,
  })
}

type DMRow = {
  id: string
  user1Id: string
  user2Id: string
  lastMessageAt: string | null
  createdAt: string
}

type DMAccess = DMRow & { otherUserId: string }

/**
 * Verify the caller can access this DM: participates AND not in a blocked
 * relationship. Returns the DM row plus the other participant's userId so
 * callers don't have to compute it themselves.
 *
 * The block check is folded in on purpose — every DM endpoint needs it, and
 * the three-line ritual (participant → other → not-blocked) is easy to skip
 * silently. If a future endpoint genuinely needs "participant but skip
 * block" semantics (e.g. an unblock-then-list flow), add an explicit
 * `requireDMParticipantAllowBlocked` helper naming the use case — never
 * re-inline the three-liner at the call site.
 */
export async function requireDMParticipant(
  db: Database,
  dmId: string,
  userId: string,
): Promise<Result<DMAccess>> {
  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return err(404, "dm not found")
  if (!dm.user1Id || !dm.user2Id) return err(404, "dm not found")
  if (dm.user1Id !== userId && dm.user2Id !== userId) return err(403, "forbidden")
  const otherUserId = dm.user1Id === userId ? dm.user2Id : dm.user1Id
  const blocked = await queries.communityFriendship.isBlocked(db, userId, otherUserId)
  if (blocked) return err(403, "blocked")
  return ok({
    id: dm.id,
    user1Id: dm.user1Id,
    user2Id: dm.user2Id,
    lastMessageAt: dm.lastMessageAt,
    createdAt: dm.createdAt,
    otherUserId,
  })
}

/**
 * Verify neither user has blocked the other. Returns an error if blocked, ok
 * otherwise. Kept exported for two non-DM callers where the participants
 * aren't (yet) joined by a DM row: DM *create* and the friend-request gate.
 */
export async function requireNotBlocked(
  db: Database,
  userA: string,
  userB: string,
): Promise<Result<true>> {
  const blocked = await queries.communityFriendship.isBlocked(db, userA, userB)
  if (blocked) return err(403, "blocked")
  return ok(true)
}

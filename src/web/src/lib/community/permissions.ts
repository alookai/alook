import { queries, canManageServer } from "@alook/shared"
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

/** Verify the caller is a member of the server that owns the channel; returns the channel row. */
export async function requireChannelMember(
  db: Database,
  channelId: string,
  userId: string,
): Promise<Result<NonNullable<Awaited<ReturnType<typeof queries.communityChannel.getChannelForMember>>>>> {
  const channel = await queries.communityChannel.getChannelForMember(db, channelId, userId)
  if (!channel) return err(403, "forbidden")
  return ok(channel)
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

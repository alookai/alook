import { queries, canManageServer } from "@alook/shared"
import type { Database } from "@alook/shared"

export type PermissionError =
  | { ok: false; status: 401 | 403 | 404; error: string }

export type Ok<T> = { ok: true; value: T }
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

/** Verify the caller participates in the DM conversation; returns the DM row with non-null participants. */
export async function requireDMParticipant(
  db: Database,
  dmId: string,
  userId: string,
): Promise<Result<DMRow>> {
  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return err(404, "dm not found")
  if (!dm.user1Id || !dm.user2Id) return err(404, "dm not found")
  if (dm.user1Id !== userId && dm.user2Id !== userId) return err(403, "forbidden")
  return ok({
    id: dm.id,
    user1Id: dm.user1Id,
    user2Id: dm.user2Id,
    lastMessageAt: dm.lastMessageAt,
    createdAt: dm.createdAt,
  })
}

/** Verify neither user has blocked the other. Returns an error if blocked, ok otherwise. */
export async function requireNotBlocked(
  db: Database,
  userA: string,
  userB: string,
): Promise<Result<true>> {
  const blocked = await queries.communityFriendship.isBlocked(db, userA, userB)
  if (blocked) return err(403, "blocked")
  return ok(true)
}

/** Return the other participant of a DM, given the caller's userId. */
export function otherDmParticipant(
  dm: { user1Id: string; user2Id: string },
  selfUserId: string,
): string {
  return dm.user1Id === selfUserId ? dm.user2Id : dm.user1Id
}

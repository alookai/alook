import {
  queries,
  canManageServer,
  canSeePrivateChannel,
  visibilityIsDmParticipant,
  withD1Retry,
} from "@alook/shared"
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
  const channel = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, userId),
    { route: "community/permissions:channel-member" },
  )
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
 * Child threads inherit their parent anchor's audience (the context
 * query climbs `parentChannelId`); a forum/top-level channel owns its roster.
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
  // `ctx.isCreator` is the ACCESS creator (the anchor's creator — for a
  // post/thread that's the forum/parent-channel creator). Post-manage rights
  // (edit tags / delete) are derived at the route from `channel.creatorId`.
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

type DMAccess = {
  id: string
  lastMessageAt: string | null
  createdAt: string
  otherUserId: string
}

/**
 * Verify the caller can access this DM channel: holds a relation='access'
 * member row on the `type=dm` channel AND is not in a blocked relationship
 * with the peer. Returns the DM channel row plus the other participant's
 * userId so callers don't have to compute it themselves.
 *
 * The block check is folded in on purpose — every DM endpoint needs it, and
 * the ritual (access → peer → not-blocked) is easy to skip silently. If a
 * future endpoint genuinely needs "access but skip block" semantics, add an
 * explicit helper naming the use case — never re-inline the check at the call
 * site (media/[...key], search inherit it).
 */
export async function requireDMAccess(
  db: Database,
  channelId: string,
  userId: string,
): Promise<Result<DMAccess>> {
  const dm = await queries.communityDm.getDM(db, channelId)
  if (!dm) return err(404, "dm not found")
  const peer = await queries.communityDm.getDMPeer(db, channelId, userId)
  if (!peer) return err(404, "dm not found")
  const otherUserId = peer.otherUserId
  const blocked = await queries.communityFriendship.isBlocked(db, userId, otherUserId)
  if (blocked) return err(403, "blocked")
  return ok({
    id: dm.id,
    lastMessageAt: dm.lastMessageAt,
    createdAt: dm.createdAt,
    otherUserId,
  })
}

export type MessageSurfaceAccess =
  | { surface: "dm"; dm: DMAccess }
  | {
      surface: "channel"
      channel: NonNullable<Awaited<ReturnType<typeof queries.communityChannel.getChannelForMember>>>
    }

/**
 * Unified message-surface access gate for the id-in-path trunk
 * (`channels/[id]/*`). One channelId, dispatched to the RIGHT per-surface gate
 * by the channel's stored type — because a DM is a `type='dm'` row in the same
 * channel id-space, so feeding a DM's id to the plain `requireChannelMember`
 * path would pass (it has no block check) and let a BLOCKED user still act. The
 * trunk must therefore route a DM id to `requireDMAccess`, not collapse every
 * surface onto one gate.
 *
 * ⚠ Surface axis is orthogonal to the type tree (Aigneis #142 / B3): unifying
 * the ROUTE structure must NOT flatten the per-surface no-access contract. Each
 * arm keeps its own existence-mask discipline BY CONSTRUCTION:
 *   - **dm** → `requireDMAccess`: unknown / non-participant → 404 (masks DM
 *     existence); a real, known participant who is blocked → 403 (a legitimate
 *     403 that doesn't disclose existence to a stranger).
 *   - **channel / thread / forum(_post)** → the two-step contract sibling
 *     channel routes honor: unknown channel → 404, known channel + non-member →
 *     403. `requireChannelMember` alone collapses both to 403 (the JOIN can't
 *     tell them apart), so the 404 is produced HERE by the explicit getChannel
 *     probe first — preserving the human 403/404 split.
 *
 * The dm-block fold (requireDMAccess) is exactly the P0 the trunk closes: the
 * old plain-channel message path never ran it.
 */
export async function requireMessageSurfaceAccess(
  db: Database,
  channelId: string,
  userId: string,
): Promise<Result<MessageSurfaceAccess>> {
  // One existence probe, reused for the type dispatch AND the channel-arm's
  // 404 leg — so an unknown id is a single 404 on every surface.
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return err(404, "not found")

  // Dispatch on the VISIBILITY trait, not a bare `type === "dm"` literal — the
  // DM-participant visibility rule lives once in the trait table
  // (visibilityIsDmParticipant, B3 "instead of each re-testing type==='dm'"),
  // and this gate consumes it. Keeps who-is-a-dm / how-it-gates single-source
  // (route dispatch consumes CHANNEL_TRAITS, never re-derives a parallel
  // type→route judgement) and avoids seeding a literal type-switch the later
  // forum/thread arms would copy into a parallel type tree.
  if (visibilityIsDmParticipant(channel.type)) {
    const dm = await requireDMAccess(db, channelId, userId)
    if (!dm.ok) {
      // ④ opaque 404 (Aigneis #157): a 404 here and the top-level unknown-id
      // 404 must be byte-identical in body, not just status — else a stranger
      // holding a real DM's id reads "dm not found" and learns the id IS a DM.
      // The whole point of this gate is a UNIFIED no-access contract, so don't
      // leak the surface word through the 404 text. A 403 (blocked) is a
      // legitimate known-participant state and stays distinguishable.
      if (dm.status === 404) return err(404, "not found")
      return dm
    }
    return ok({ surface: "dm", dm: dm.value })
  }

  // channel / thread / forum: the id is known (probe above), so
  // requireChannelMember's collapse-to-403 now only fires for a real
  // non-member — the unknown case already 404'd. Preserves the 403/404 split.
  const member = await requireChannelMember(db, channelId, userId)
  if (!member.ok) return member
  return ok({ surface: "channel", channel: member.value })
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

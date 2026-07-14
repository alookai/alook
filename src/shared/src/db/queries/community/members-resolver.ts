import { eq } from "drizzle-orm";
import {
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import type { CommunityRole } from "../../../utils/community-roles";
import { canManageServer, isForum, isForumPost } from "../../../utils/community-roles";
import {
  getPrivateChannelAudienceUserIds,
  isChannelPrivate,
  listChannelMemberUserIds,
} from "./channel";
import { listMemberUserIds } from "./member";

// Scopes whose member set is derived, not stored. A thread / forum_post has no
// roster of its own — it inherits the audience of its anchor channel.
export type ScopeKind = "channel" | "thread" | "post";

// Why a user is in the resolved set. Lets callers distinguish an explicitly
// added private-channel member from an inherited public-channel member or a
// server admin who sees everything.
export type MemberSource = "explicit" | "inherited" | "admin";

export type ScopeMember = {
  userId: string;
  role: CommunityRole;
  source: MemberSource;
};

/**
 * The single source of truth for "who is in this scope." Consolidates the
 * public/private split that fan-out and the WS DO used to hand-roll:
 *
 *   - public / uncategorized channel (or a thread/post anchored to one) →
 *     every server member (unfiltered — matches `listMemberUserIds`, so a
 *     soft-deleted user is still in the set; a dead user simply has no live
 *     socket to receive a broadcast).
 *   - private-category channel (or a thread/post anchored to one) → the
 *     channel audience: explicit members ∪ anchor creator ∪ server
 *     admins/owner (delegates to `getPrivateChannelAudienceUserIds`, which
 *     already climbs `parentChannelId`).
 *
 * `thread` / `post` resolve identically to `channel` — every reader climbs to
 * the anchor — so the scope tag is documentation, not branching.
 */
export async function resolveScopeMemberUserIds(
  db: Database,
  { scopeId }: { scope: ScopeKind; scopeId: string }
): Promise<string[]> {
  const channel = await db
    .select({ serverId: communityChannel.serverId })
    .from(communityChannel)
    .where(eq(communityChannel.id, scopeId))
    .limit(1);
  if (channel.length === 0) return [];

  if (await isChannelPrivate(db, scopeId)) {
    return getPrivateChannelAudienceUserIds(db, scopeId);
  }
  return listMemberUserIds(db, channel[0]!.serverId);
}

/**
 * Same resolution as `resolveScopeMemberUserIds`, tagged with each member's
 * server role and the reason they belong to the scope:
 *   - `admin`     — server owner/admin (always in every audience).
 *   - `explicit`  — an explicitly added private-channel member or the anchor
 *                   creator.
 *   - `inherited` — a plain server member of a public/uncategorized channel.
 */
export async function resolveScopeMembers(
  db: Database,
  { scope, scopeId }: { scope: ScopeKind; scopeId: string }
): Promise<ScopeMember[]> {
  const userIds = await resolveScopeMemberUserIds(db, { scope, scopeId });
  if (userIds.length === 0) return [];

  const target = await db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      type: communityChannel.type,
      creatorId: communityChannel.creatorId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, scopeId))
    .limit(1);
  if (target.length === 0) return [];
  const serverId = target[0]!.serverId;
  const type = target[0]!.type;

  // Server roles for every resolved user — scoped to this server up front.
  const roleRows = await db
    .select({ userId: communityServerMember.userId, role: communityServerMember.role })
    .from(communityServerMember)
    .where(eq(communityServerMember.serverId, serverId));
  const roleByUser = new Map<string, CommunityRole>();
  for (const r of roleRows) roleByUser.set(r.userId, r.role as CommunityRole);

  const isPrivate = await isChannelPrivate(db, scopeId);

  // "explicit" = the added members ∪ the unit's own creator, per the
  // nested-membership roster rules:
  //   - forum_post → the post's OWN members ∪ post creator (no forum climb).
  //   - forum      → the union of its posts' explicit members ∪ post creators ∪
  //                  forum creator (derived).
  //   - thread/channel → the (climbed) anchor's members ∪ anchor creator.
  // For a PRIVATE unit every resolved user is now `explicit` (admins are no
  // longer auto-included — the audience is exactly members ∪ creator). For a
  // PUBLIC unit the audience is all server members, tagged admin/inherited.
  const explicit = new Set<string>();
  if (isPrivate) {
    if (isForum(type)) {
      if (target[0]!.creatorId) explicit.add(target[0]!.creatorId);
      const posts = await db
        .select({ id: communityChannel.id, creatorId: communityChannel.creatorId })
        .from(communityChannel)
        .where(eq(communityChannel.parentChannelId, scopeId));
      for (const p of posts) {
        for (const id of await listChannelMemberUserIds(db, p.id)) explicit.add(id);
        if (p.creatorId) explicit.add(p.creatorId);
      }
    } else {
      const rosterAnchorId =
        isForumPost(type) ? target[0]!.id : (target[0]!.parentChannelId ?? target[0]!.id);
      for (const id of await listChannelMemberUserIds(db, rosterAnchorId)) explicit.add(id);
      const rosterCreatorId =
        isForumPost(type)
          ? target[0]!.creatorId
          : (await db
              .select({ creatorId: communityChannel.creatorId })
              .from(communityChannel)
              .where(eq(communityChannel.id, rosterAnchorId))
              .limit(1))[0]?.creatorId;
      if (rosterCreatorId) explicit.add(rosterCreatorId);
    }
  }

  return userIds.map((userId) => {
    const role = roleByUser.get(userId) ?? "member";
    let source: MemberSource;
    if (!isPrivate) {
      source = canManageServer(role) ? "admin" : "inherited";
    } else if (explicit.has(userId)) {
      source = "explicit";
    } else {
      source = "admin";
    }
    return { userId, role, source };
  });
}

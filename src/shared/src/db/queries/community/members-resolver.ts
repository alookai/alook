import { eq } from "drizzle-orm";
import {
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import type { CommunityRole } from "../../../utils/community-roles";
import { canManageServer } from "../../../utils/community-roles";
import {
  getPrivateChannelAudienceUserIds,
  isChannelPrivate,
  listChannelMemberUserIds,
} from "./channel";
import { listMemberUserIds } from "./member";

// The ACCESS scopes — units that own (or inherit) a stored/derived access
// roster. `forum` resolves like a top-level text channel (its own roster);
// `channel` is a top-level text channel. Thread / forum_post are NOT here: they
// are the NOTIFICATION dimension (participant set), resolved at the call site
// via `listThreadParticipantUserIds` — never through this resolver.
export type ScopeKind = "channel" | "forum";

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
 * The single source of truth for "who can access this scope." Consolidates the
 * public/private split for the ACCESS dimension:
 *
 *   - public / uncategorized channel/forum → every server member (unfiltered —
 *     matches `listMemberUserIds`, so a soft-deleted user is still in the set; a
 *     dead user simply has no live socket to receive a broadcast).
 *   - private-category channel/forum → the channel audience: explicit members ∪
 *     creator (delegates to `getPrivateChannelAudienceUserIds`, which climbs
 *     `parentChannelId` so a forum resolves its own roster like a text channel).
 *
 * Only ACCESS units (`channel`/`forum`) reach here. Notify units (thread /
 * forum_post) resolve their recipient set from the participant table at the
 * call site.
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
      creatorId: communityChannel.creatorId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, scopeId))
    .limit(1);
  if (target.length === 0) return [];
  const serverId = target[0]!.serverId;

  // Server roles for every resolved user — scoped to this server up front.
  const roleRows = await db
    .select({ userId: communityServerMember.userId, role: communityServerMember.role })
    .from(communityServerMember)
    .where(eq(communityServerMember.serverId, serverId));
  const roleByUser = new Map<string, CommunityRole>();
  for (const r of roleRows) roleByUser.set(r.userId, r.role as CommunityRole);

  const isPrivate = await isChannelPrivate(db, scopeId);

  // "explicit" = the anchor's added members ∪ the anchor's own creator. The
  // anchor is `parentChannelId ?? id`, so a forum/channel uses its own roster.
  // For a PRIVATE unit every resolved user is `explicit` (admins are no longer
  // auto-included — the audience is exactly members ∪ creator). For a PUBLIC
  // unit the audience is all server members, tagged admin/inherited.
  const explicit = new Set<string>();
  if (isPrivate) {
    const anchorId = target[0]!.parentChannelId ?? target[0]!.id;
    for (const id of await listChannelMemberUserIds(db, anchorId)) explicit.add(id);
    const anchorCreatorId =
      anchorId === target[0]!.id
        ? target[0]!.creatorId
        : (await db
            .select({ creatorId: communityChannel.creatorId })
            .from(communityChannel)
            .where(eq(communityChannel.id, anchorId))
            .limit(1))[0]?.creatorId;
    if (anchorCreatorId) explicit.add(anchorCreatorId);
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

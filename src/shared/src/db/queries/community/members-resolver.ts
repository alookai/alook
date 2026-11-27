import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import { jsonTextSet } from "../_json-set";
import type { CommunityRole } from "../../../utils/community-roles";
import {
  canManageServer,
  channelReach,
  isStoredChannelType,
} from "../../../utils/community-roles";
import {
  getChannelType,
  filterChannelReadableUserIds,
  getPrivateChannelAudienceUserIds,
  isChannelPrivate,
  listChannelMemberUserIds,
} from "./channel";
import { listMemberUserIds } from "./member";
import { listThreadParticipantUserIds } from "./thread";

// Why a user is in the resolved set. Lets callers distinguish an explicitly
// added private-channel member from an inherited public-channel member or a
// server admin who sees everything.
export type MemberSource = "explicit" | "inherited" | "admin";

export type ScopeMember = {
  userId: string;
  role: CommunityRole;
  source: MemberSource;
};

export type ChannelRecipientQueryPhase =
  | "channel-type"
  | "thread-participants"
  | "dm-members"
  | "scope-members"
  | "readable-members";

export type ChannelRecipientQueryRunner = <T>(
  phase: ChannelRecipientQueryPhase,
  query: () => Promise<T>,
) => Promise<T>;

const runChannelRecipientQuery: ChannelRecipientQueryRunner = (_phase, query) => query();

export async function resolveChannelNotificationRecipientUserIds(
  db: Database,
  channelId: string,
  runQuery: ChannelRecipientQueryRunner = runChannelRecipientQuery,
): Promise<string[]> {
  const type = await runQuery("channel-type", () => getChannelType(db, channelId));
  const reach = isStoredChannelType(type) ? channelReach(type) : "server-or-roster";
  switch (reach) {
    case "participant-set":
      return runQuery("thread-participants", () => listThreadParticipantUserIds(db, channelId));
    case "dm-pair":
      return runQuery("dm-members", () => listChannelMemberUserIds(db, channelId));
    case "server-or-roster":
      return runQuery(
        "scope-members",
        () => resolveScopeMemberUserIds(db, channelId),
      );
    default: {
      const _never: never = reach;
      return _never;
    }
  }
}

export async function resolveChannelContentRecipientUserIds(
  db: Database,
  channelId: string,
  runQuery: ChannelRecipientQueryRunner = runChannelRecipientQuery,
): Promise<string[]> {
  const type = await runQuery("channel-type", () => getChannelType(db, channelId));
  if (!isStoredChannelType(type)) return [];
  if (type === "dm") {
    return runQuery("dm-members", () => listChannelMemberUserIds(db, channelId));
  }
  const channel = await runQuery("scope-members", async () => {
    const rows = await db
      .select({ serverId: communityChannel.serverId })
      .from(communityChannel)
      .where(eq(communityChannel.id, channelId))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!channel) return [];
  const isPrivate = await runQuery("scope-members", () => isChannelPrivate(db, channelId));
  if (!isPrivate) {
    return runQuery("scope-members", () => listMemberUserIds(db, channel.serverId));
  }
  const candidates = await runQuery("scope-members", () => getPrivateChannelAudienceUserIds(db, channelId));
  if (candidates.length === 0) return [];
  return runQuery("readable-members", () => filterChannelReadableUserIds(db, channelId, candidates));
}

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
 */
export async function resolveScopeMemberUserIds(
  db: Database,
  scopeId: string
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
  scopeId: string,
  opts?: { limit?: number; cursor?: string }
): Promise<ScopeMember[]> {
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
  const isPrivate = await isChannelPrivate(db, scopeId);

  if (!isPrivate) {
    const conditions = [eq(communityServerMember.serverId, serverId)];
    if (opts?.cursor) {
      conditions.push(gt(communityServerMember.userId, opts.cursor));
    }
    const baseQuery = db
      .select({ userId: communityServerMember.userId, role: communityServerMember.role })
      .from(communityServerMember)
      .where(and(...conditions))
      .orderBy(asc(communityServerMember.userId));
    const rows = opts?.limit !== undefined ? await baseQuery.limit(opts.limit) : await baseQuery;
    return rows.map((r) => {
      const role = (r.role as CommunityRole) ?? "member";
      return {
        userId: r.userId,
        role,
        source: canManageServer(role) ? "admin" : "inherited",
      };
    });
  }

  const anchorId = target[0]!.parentChannelId ?? target[0]!.id;
  const explicit = new Set<string>(await listChannelMemberUserIds(db, anchorId));
  const anchorCreatorId =
    anchorId === target[0]!.id
      ? target[0]!.creatorId
      : (await db
          .select({ creatorId: communityChannel.creatorId })
          .from(communityChannel)
          .where(eq(communityChannel.id, anchorId))
          .limit(1))[0]?.creatorId;
  if (anchorCreatorId) explicit.add(anchorCreatorId);

  let userIds = [...explicit];
  if (opts?.cursor !== undefined || opts?.limit !== undefined) {
    userIds.sort();
    if (opts.cursor !== undefined) {
      const cursor = opts.cursor;
      userIds = userIds.filter((id) => id > cursor);
    }
    if (opts.limit !== undefined) {
      userIds = userIds.slice(0, opts.limit);
    }
  }
  if (userIds.length === 0) return [];

  const roleRows = await db
    .select({ userId: communityServerMember.userId, role: communityServerMember.role })
    .from(communityServerMember)
    .where(and(
      eq(communityServerMember.serverId, serverId),
      inArray(communityServerMember.userId, jsonTextSet(db, userIds)),
    ));
  const roleByUser = new Map<string, CommunityRole>();
  for (const r of roleRows) roleByUser.set(r.userId, r.role as CommunityRole);

  return userIds.map((userId) => ({
    userId,
    role: roleByUser.get(userId) ?? "member",
    source: "explicit",
  }));
}

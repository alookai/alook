import { eq, and, desc, isNull, inArray } from "drizzle-orm";
import { communityChannel, communityChannelMember } from "../../community-schema";
import { user } from "../../schema";
import { PARTICIPANT_SOURCE } from "../../../constants/community";
import type { Database } from "../../index";

// DMs are channels now (type='dm', server_id NULL). Their two participants are
// relation='access' community_channel_member rows. One-DM-per-pair is enforced
// at the application layer by a runtime member-set query — no stored uniqueness
// key. See plans/community-schema-unification.md.

/**
 * Find the existing type='dm' channel whose relation='access' member set is
 * EXACTLY {a,b} — both present AND no third access member. Returns the channel
 * id or null.
 */
async function findDmChannelId(
  db: Database,
  userAId: string,
  userBId: string
): Promise<string | null> {
  // Candidate DM channels the pair could share: only the DM channels userA
  // holds an access row on (bounded to A's own DMs, not every DM in the
  // system). A shared DM must appear here.
  const aRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannel.type, "dm"),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannelMember.userId, userAId)
      )
    );
  const candidateIds = aRows.map((r) => r.channelId);
  if (candidateIds.length === 0) return null;

  // The full access-member set of A's DM channels — a pair's DM has EXACTLY
  // {a,b} (guards against a 3rd member) and contains b.
  const memberRows = await db
    .select({
      channelId: communityChannelMember.channelId,
      userId: communityChannelMember.userId,
    })
    .from(communityChannelMember)
    .where(
      and(
        inArray(communityChannelMember.channelId, candidateIds),
        eq(communityChannelMember.relation, "access")
      )
    );

  const byChannel = new Map<string, Set<string>>();
  for (const r of memberRows) {
    let set = byChannel.get(r.channelId);
    if (!set) {
      set = new Set<string>();
      byChannel.set(r.channelId, set);
    }
    set.add(r.userId);
  }
  for (const [channelId, set] of byChannel) {
    if (set.size === 2 && set.has(userAId) && set.has(userBId)) return channelId;
  }
  return null;
}

export async function createOrGetDM(
  db: Database,
  data: { userId1: string; userId2: string }
) {
  const existingId = await findDmChannelId(db, data.userId1, data.userId2);
  if (existingId) {
    const rows = await db
      .select()
      .from(communityChannel)
      .where(eq(communityChannel.id, existingId));
    return rows[0]!;
  }

  const inserted = await db
    .insert(communityChannel)
    .values({ type: "dm", serverId: null, name: null, topic: "" })
    .returning();
  const channel = inserted[0]!;

  const now = new Date().toISOString();
  await db.insert(communityChannelMember).values([
    {
      channelId: channel.id,
      userId: data.userId1,
      relation: "access",
      source: PARTICIPANT_SOURCE.ADDED,
      addedAt: now,
    },
    {
      channelId: channel.id,
      userId: data.userId2,
      relation: "access",
      source: PARTICIPANT_SOURCE.ADDED,
      addedAt: now,
    },
  ]);

  return channel;
}

// The ids of every DM channel the user has access to (type='dm' channels where
// they hold a relation='access' member row). DMs carry `server_id = NULL`, so
// they are structurally absent from `listVisibleChannelIdsForUser` (which walks
// the user's server memberships). A caller that needs DM messages in scope —
// e.g. the Marked inbox tab, which spans DMs as well as server channels — unions
// these ids in. Access-membership IS the DM visibility gate, so a mark in a DM
// the user isn't a member of never surfaces.
export async function listDmChannelIdsForUser(
  db: Database,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.id, communityChannelMember.channelId)
    )
    .where(
      and(
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm")
      )
    );
  return rows.map((r) => r.channelId);
}

export async function listDMs(db: Database, userId: string) {
  // DM channels the user holds an access row on, joined to the OTHER access
  // member → user for display. Order by last_message_at DESC.
  const selfRows = await db
    .select({ channelId: communityChannelMember.channelId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm")
      )
    );
  const dmIds = selfRows.map((r) => r.channelId);
  if (dmIds.length === 0) return [];

  const rows = await db
    .select({
      id: communityChannel.id,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserEmail: user.email,
      otherUserImage: user.image,
      otherUserDiscriminator: user.discriminator,
      lastMessageAt: communityChannel.lastMessageAt,
      createdAt: communityChannel.createdAt,
    })
    .from(communityChannel)
    .innerJoin(
      communityChannelMember,
      and(
        eq(communityChannelMember.channelId, communityChannel.id),
        eq(communityChannelMember.relation, "access")
      )
    )
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .where(
      and(
        inArray(communityChannel.id, dmIds),
        isNull(user.deletedAt)
      )
    )
    .orderBy(desc(communityChannel.lastMessageAt));

  // The join above returns EVERY access member (including self). Keep only the
  // peer rows, then de-dupe defensively by peer (guards the deferred
  // concurrency edge — two DM channels for one pair).
  const seenPeers = new Set<string>();
  const result: typeof rows = [];
  for (const r of rows) {
    if (r.otherUserId === userId) continue;
    if (seenPeers.has(r.otherUserId)) continue;
    seenPeers.add(r.otherUserId);
    result.push(r);
  }
  return result.sort((a, b) => {
    const aTime = a.lastMessageAt ?? a.createdAt;
    const bTime = b.lastMessageAt ?? b.createdAt;
    return bTime.localeCompare(aTime);
  });
}

export async function getDM(db: Database, channelId: string) {
  const rows = await db
    .select()
    .from(communityChannel)
    .where(and(eq(communityChannel.id, channelId), eq(communityChannel.type, "dm")));
  return rows[0] ?? null;
}

/**
 * Read-only lookup of an existing DM between two users. Returns `null` if the
 * pair has never opened a DM — does NOT create one (that's `createOrGetDM`).
 * Used by `resolveTargetForMember` when `createDmIfMissing: false`.
 */
export async function getDMBetween(db: Database, userAId: string, userBId: string) {
  const channelId = await findDmChannelId(db, userAId, userBId);
  if (!channelId) return null;
  const rows = await db
    .select()
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId));
  return rows[0] ?? null;
}

/**
 * The two access-member user ids of a DM channel, and (for a caller-supplied
 * viewer) the resolved peer. Returns null when the channel isn't a DM or the
 * viewer isn't an access member.
 */
export async function getDMPeer(
  db: Database,
  channelId: string,
  userId: string
): Promise<{ otherUserId: string } | null> {
  const rows = await db
    .select({ userId: communityChannelMember.userId })
    .from(communityChannelMember)
    .innerJoin(communityChannel, eq(communityChannel.id, communityChannelMember.channelId))
    .where(
      and(
        eq(communityChannelMember.channelId, channelId),
        eq(communityChannelMember.relation, "access"),
        eq(communityChannel.type, "dm")
      )
    );
  const memberIds = rows.map((r) => r.userId);
  if (!memberIds.includes(userId)) return null;
  const other = memberIds.find((id) => id !== userId);
  if (!other) return null;
  return { otherUserId: other };
}

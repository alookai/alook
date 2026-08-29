import { eq, and, asc, desc, exists, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { communityChannel, communityChannelMember, communityFriendship } from "../../community-schema";
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
  const selfMember = alias(communityChannelMember, "dm_self_member");
  const peerMember = alias(communityChannelMember, "dm_peer_member");
  const thirdMember = alias(communityChannelMember, "dm_third_member");
  const rows = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(
      and(
        eq(communityChannel.type, "dm"),
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(selfMember)
            .where(
              and(
                eq(selfMember.channelId, communityChannel.id),
                eq(selfMember.userId, userAId),
                eq(selfMember.relation, "access")
              )
            )
        ),
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(peerMember)
            .where(
              and(
                eq(peerMember.channelId, communityChannel.id),
                eq(peerMember.userId, userBId),
                eq(peerMember.relation, "access")
              )
            )
        ),
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(thirdMember)
            .where(
              and(
                eq(thirdMember.channelId, communityChannel.id),
                eq(thirdMember.relation, "access"),
                ne(thirdMember.userId, userAId),
                ne(thirdMember.userId, userBId)
              )
            )
        )
      )
    )
    .orderBy(asc(communityChannel.id))
    .limit(1);
  return rows[0]?.id ?? null;
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

// The ids of every readable DM channel for the user. Access membership is
// necessary but not sufficient: a block in either direction makes the DM
// message surface unreadable. The correlated anti-join excludes blocked peers
// in this one batched query rather than running isBlocked once per DM.
export async function listDmChannelIdsForUser(
  db: Database,
  userId: string
): Promise<string[]> {
  const peer = alias(communityChannelMember, "readable_dm_peer");
  const friendship = alias(communityFriendship, "readable_dm_block");
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
        eq(communityChannel.type, "dm"),
        notExists(
          db
            .select({ requesterId: friendship.requesterId })
            .from(peer)
            .innerJoin(
              friendship,
              and(
                eq(friendship.status, "blocked"),
                or(
                  and(
                    eq(friendship.requesterId, userId),
                    eq(friendship.addresseeId, peer.userId)
                  ),
                  and(
                    eq(friendship.requesterId, peer.userId),
                    eq(friendship.addresseeId, userId)
                  )
                )
              )
            )
            .where(
              and(
                eq(peer.channelId, communityChannelMember.channelId),
                eq(peer.relation, "access"),
                ne(peer.userId, userId)
              )
            )
        )
      )
    );
  return rows.map((r) => r.channelId);
}

export async function listDmPeerUserIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const self = alias(communityChannelMember, "identity_dm_self")
  const peer = alias(communityChannelMember, "identity_dm_peer")
  const block = alias(communityFriendship, "identity_dm_block")
  const rows = await db
    .selectDistinct({ userId: user.id })
    .from(communityChannel)
    .innerJoin(
      self,
      and(
        eq(self.channelId, communityChannel.id),
        eq(self.userId, userId),
        eq(self.relation, "access"),
      ),
    )
    .innerJoin(
      peer,
      and(
        eq(peer.channelId, communityChannel.id),
        ne(peer.userId, userId),
        eq(peer.relation, "access"),
      ),
    )
    .innerJoin(user, eq(user.id, peer.userId))
    .where(and(
      eq(communityChannel.type, "dm"),
      isNull(user.deletedAt),
      notExists(
        db
          .select({ requesterId: block.requesterId })
          .from(block)
          .where(and(
            eq(block.status, "blocked"),
            or(
              and(eq(block.requesterId, userId), eq(block.addresseeId, peer.userId)),
              and(eq(block.requesterId, peer.userId), eq(block.addresseeId, userId)),
            ),
          )),
      ),
    ))
  return rows.map((row) => row.userId)
}

export async function listDMs(db: Database, userId: string) {
  const selfMember = alias(communityChannelMember, "dm_list_self");
  const peerMember = alias(communityChannelMember, "dm_list_peer");
  const rows = await db
    .select({
      id: communityChannel.id,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserEmail: user.email,
      otherUserImage: user.image,
      otherUserAvatarVersion: user.avatarVersion,
      otherUserDiscriminator: user.discriminator,
      lastMessageAt: communityChannel.lastMessageAt,
      createdAt: communityChannel.createdAt,
    })
    .from(communityChannel)
    .innerJoin(
      selfMember,
      and(
        eq(selfMember.channelId, communityChannel.id),
        eq(selfMember.userId, userId),
        eq(selfMember.relation, "access")
      )
    )
    .innerJoin(
      peerMember,
      and(
        eq(peerMember.channelId, communityChannel.id),
        eq(peerMember.relation, "access"),
        ne(peerMember.userId, userId)
      )
    )
    .innerJoin(user, eq(user.id, peerMember.userId))
    .where(
      and(
        eq(communityChannel.type, "dm"),
        isNull(user.deletedAt)
      )
    )
    .orderBy(
      desc(sql`COALESCE(${communityChannel.lastMessageAt}, ${communityChannel.createdAt})`),
      asc(communityChannel.id)
    );

  // The join above returns EVERY access member (including self). Keep only the
  // peer rows, then de-dupe defensively by peer (guards the deferred
  // concurrency edge — two DM channels for one pair).
  const seenPeers = new Set<string>();
  const result: typeof rows = [];
  for (const r of rows) {
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

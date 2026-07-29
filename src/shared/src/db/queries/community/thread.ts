import { and, eq, inArray } from "drizzle-orm";
import { communityChannel, communityChannelMember } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, maxRowsPerInsert, D1_MAX_IN_PARAMS } from "../_chunk";

// The NOTIFICATION set for a thread OR forum_post — now relation='notify' rows
// on `community_channel_member` (formerly the standalone
// community_thread_participant table). A thread/post is not an access unit —
// any parent-channel member can read it — so these rows only decide who gets
// pinged / sees the unit as unread. Admins are NOT auto-included: the notify
// set is exactly these rows.
//
// There is no per-participant mute here — muting is the OUTER channel-header
// notification level, not a property of participation. Participation is
// add / leave only. A user may also hold a relation='access' row on the same
// channel; the two coexist under the (channel_id, user_id, relation) unique.

export type ThreadParticipantSource = "mention" | "spoke" | "added";

const NOTIFY_CONFLICT_TARGET = [
  communityChannelMember.channelId,
  communityChannelMember.userId,
  communityChannelMember.relation,
] as const;

// Idempotent add. `onConflictDoNothing` so a re-mention/re-speak of an existing
// participant is a no-op (does NOT overwrite `source`).
// Returns the inserted row, or null when the participant already existed.
export async function addThreadParticipant(
  db: Database,
  data: { threadChannelId: string; userId: string; source: ThreadParticipantSource }
) {
  const rows = await db
    .insert(communityChannelMember)
    .values({
      channelId: data.threadChannelId,
      userId: data.userId,
      relation: "notify",
      source: data.source,
    })
    .onConflictDoNothing({ target: [...NOTIFY_CONFLICT_TARGET] })
    .returning();
  return rows[0] ?? null;
}

// Bulk idempotent add — one INSERT for many (userId, source) pairs. Used on the
// message-send hot path where a post can add the author + N mentioned users at
// once. Skips the query for an empty list. Does not overwrite existing rows.
export async function addThreadParticipants(
  db: Database,
  threadChannelId: string,
  rows: { userId: string; source: ThreadParticipantSource }[]
) {
  if (rows.length === 0) return;
  // communityChannelMember emits 6 bind params/row (id $defaultFn, channel_id,
  // user_id, relation, source, added_at $defaultFn; added_by is an unsupplied
  // literal null, not a param), so cap at floor(100/6)=16 rows for D1's 100-param
  // limit. `onConflictDoNothing` adds no VALUES params.
  for (const batch of chunk(rows, maxRowsPerInsert(6))) {
    await db
      .insert(communityChannelMember)
      .values(
        batch.map((r) => ({
          channelId: threadChannelId,
          userId: r.userId,
          relation: "notify",
          source: r.source,
        }))
      )
      .onConflictDoNothing({ target: [...NOTIFY_CONFLICT_TARGET] });
  }
}

// The NOTIFY set: every participant userId. This is what thread fan-out /
// mention rows / inbox unread scope to.
export async function listThreadParticipantUserIds(
  db: Database,
  threadChannelId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityChannelMember.userId })
    .from(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.relation, "notify")
      )
    );
  return rows.map((r) => r.userId);
}

// Full participant list hydrated for display — the thread's participant panel.
export async function listThreadParticipants(
  db: Database,
  threadChannelId: string
) {
  return db
    .select({
      userId: communityChannelMember.userId,
      source: communityChannelMember.source,
      addedAt: communityChannelMember.addedAt,
      userName: user.name,
      userImage: user.image,
      discriminator: user.discriminator,
    })
    .from(communityChannelMember)
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.relation, "notify")
      )
    );
}

// Batch participant hydration for many channels at once — the forum post list's
// per-card AvatarGroup. One query for N post ids instead of N. Rows carry the
// channel id so the caller can group them back per post; `addedAt` orders the
// group. Soft-deleted users drop out via the inner join.
export async function listParticipantsForChannels(
  db: Database,
  channelIds: string[]
) {
  if (channelIds.length === 0) return [];
  return db
    .select({
      channelId: communityChannelMember.channelId,
      userId: communityChannelMember.userId,
      addedAt: communityChannelMember.addedAt,
      userName: user.name,
      userImage: user.image,
    })
    .from(communityChannelMember)
    .innerJoin(user, eq(user.id, communityChannelMember.userId))
    .where(
      and(
        inArray(communityChannelMember.channelId, channelIds),
        eq(communityChannelMember.relation, "notify")
      )
    );
}

export async function isThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityChannelMember.id })
    .from(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .limit(1);
  return rows.length > 0;
}

// Leave: drop the notify row entirely (a later mention/speak re-adds). Returns
// the removed row or null.
export async function removeThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
) {
  const rows = await db
    .delete(communityChannelMember)
    .where(
      and(
        eq(communityChannelMember.channelId, threadChannelId),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .returning();
  return rows[0] ?? null;
}

// Drop a user's notify rows from EVERY child channel (forum_post OR thread)
// under a top-level unit. Called when a member is removed from a forum/channel's
// access roster: their access is gone, so their leftover notify rows on the
// unit's posts/threads must go too. A later mention/speak (which requires
// access) re-adds them. Returns the count of removed rows.
export async function removeParticipantFromChildChannels(
  db: Database,
  parentChannelId: string,
  userId: string
): Promise<number> {
  const children = await db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(eq(communityChannel.parentChannelId, parentChannelId));
  const childIds = children.map((c) => c.id);
  if (childIds.length === 0) return 0;
  const removed = await db
    .delete(communityChannelMember)
    .where(
      and(
        inArray(communityChannelMember.channelId, childIds),
        eq(communityChannelMember.userId, userId),
        eq(communityChannelMember.relation, "notify")
      )
    )
    .returning();
  return removed.length;
}

// Of the given thread ids, which the user participates in (notify). Batch form
// for the inbox unread-threads filter.
export async function listParticipatingThreadIds(
  db: Database,
  threadChannelIds: string[],
  userId: string
): Promise<string[]> {
  if (threadChannelIds.length === 0) return [];
  // Chunk the `inArray` for D1's 100-param limit; no order/limit → concat.
  const rows = (
    await Promise.all(
      chunk(threadChannelIds, D1_MAX_IN_PARAMS).map((ids) =>
        db
          .select({ channelId: communityChannelMember.channelId })
          .from(communityChannelMember)
          .where(
            and(
              inArray(communityChannelMember.channelId, ids),
              eq(communityChannelMember.userId, userId),
              eq(communityChannelMember.relation, "notify")
            )
          )
      )
    )
  ).flat();
  return rows.map((r) => r.channelId);
}

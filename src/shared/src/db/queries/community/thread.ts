import { and, eq, inArray } from "drizzle-orm";
import { communityThreadParticipant } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

// The NOTIFICATION set for a thread (see `community_thread_participant`). A
// thread is not an access unit — any parent-channel member can read it — so
// these rows only decide who gets pinged / sees the thread as unread. Admins
// are NOT auto-included: the notify set is exactly these rows.
//
// There is no per-participant mute here — muting a thread is the OUTER channel-
// header notification level (per-layer, same control a channel uses), not a
// property of participation. Participation is add / leave only.

export type ThreadParticipantSource = "mention" | "spoke" | "added";

// Idempotent add. `onConflictDoNothing` so a re-mention/re-speak of an existing
// participant is a no-op (does NOT overwrite `source`).
// Returns the inserted row, or null when the participant already existed.
export async function addThreadParticipant(
  db: Database,
  data: { threadChannelId: string; userId: string; source: ThreadParticipantSource }
) {
  const rows = await db
    .insert(communityThreadParticipant)
    .values({
      threadChannelId: data.threadChannelId,
      userId: data.userId,
      source: data.source,
    })
    .onConflictDoNothing({
      target: [communityThreadParticipant.threadChannelId, communityThreadParticipant.userId],
    })
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
  await db
    .insert(communityThreadParticipant)
    .values(rows.map((r) => ({ threadChannelId, userId: r.userId, source: r.source })))
    .onConflictDoNothing({
      target: [communityThreadParticipant.threadChannelId, communityThreadParticipant.userId],
    });
}

// The NOTIFY set: every participant userId. This is what thread fan-out /
// mention rows / inbox unread scope to. (Per-user notification suppression is
// the outer channel-header notif level, not stored here.)
export async function listThreadParticipantUserIds(
  db: Database,
  threadChannelId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityThreadParticipant.userId })
    .from(communityThreadParticipant)
    .where(eq(communityThreadParticipant.threadChannelId, threadChannelId));
  return rows.map((r) => r.userId);
}

// Full participant list hydrated for display — the thread's participant panel.
export async function listThreadParticipants(
  db: Database,
  threadChannelId: string
) {
  return db
    .select({
      userId: communityThreadParticipant.userId,
      source: communityThreadParticipant.source,
      addedAt: communityThreadParticipant.addedAt,
      userName: user.name,
      userImage: user.image,
      discriminator: user.discriminator,
    })
    .from(communityThreadParticipant)
    .innerJoin(user, eq(user.id, communityThreadParticipant.userId))
    .where(eq(communityThreadParticipant.threadChannelId, threadChannelId));
}

// Batch participant hydration for many channels at once — the forum post list's
// per-card AvatarGroup. One query for N post ids instead of N. Rows carry the
// channel id so the caller can group them back per post; `addedAt` orders the
// group (creator's "spoke" row is earliest, so they lead). Soft-deleted users
// drop out via the inner join, matching how the members list hydrates.
export async function listParticipantsForChannels(
  db: Database,
  channelIds: string[]
) {
  if (channelIds.length === 0) return [];
  return db
    .select({
      channelId: communityThreadParticipant.threadChannelId,
      userId: communityThreadParticipant.userId,
      addedAt: communityThreadParticipant.addedAt,
      userName: user.name,
      userImage: user.image,
    })
    .from(communityThreadParticipant)
    .innerJoin(user, eq(user.id, communityThreadParticipant.userId))
    .where(inArray(communityThreadParticipant.threadChannelId, channelIds));
}

export async function isThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityThreadParticipant.id })
    .from(communityThreadParticipant)
    .where(
      and(
        eq(communityThreadParticipant.threadChannelId, threadChannelId),
        eq(communityThreadParticipant.userId, userId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

// Leave: drop the row entirely (a later mention/speak re-adds). Returns the
// removed row or null.
export async function removeThreadParticipant(
  db: Database,
  threadChannelId: string,
  userId: string
) {
  const rows = await db
    .delete(communityThreadParticipant)
    .where(
      and(
        eq(communityThreadParticipant.threadChannelId, threadChannelId),
        eq(communityThreadParticipant.userId, userId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

// Of the given thread ids, which the user participates in. Batch form for the
// inbox unread-threads filter.
export async function listParticipatingThreadIds(
  db: Database,
  threadChannelIds: string[],
  userId: string
): Promise<string[]> {
  if (threadChannelIds.length === 0) return [];
  const rows = await db
    .select({ threadChannelId: communityThreadParticipant.threadChannelId })
    .from(communityThreadParticipant)
    .where(
      and(
        inArray(communityThreadParticipant.threadChannelId, threadChannelIds),
        eq(communityThreadParticipant.userId, userId)
      )
    );
  return rows.map((r) => r.threadChannelId);
}

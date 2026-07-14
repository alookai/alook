import { and, eq, inArray } from "drizzle-orm";
import { communityThreadParticipant } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

// The NOTIFICATION set for a thread (see `community_thread_participant`). A
// thread is not an access unit — any parent-channel member can read it — so
// these rows only decide who gets pinged / sees the thread as unread. Admins
// are NOT auto-included: the notify set is exactly these rows with `muted = 0`.

export type ThreadParticipantSource = "mention" | "spoke" | "added";

// Idempotent add. `onConflictDoNothing` so a re-mention/re-speak of an existing
// participant is a no-op (does NOT overwrite `source` or clear `muted`).
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

// The NOTIFY set: participant userIds with notifications enabled (muted = 0).
// This is what thread fan-out / mention rows / inbox unread scope to.
export async function listThreadParticipantUserIds(
  db: Database,
  threadChannelId: string
): Promise<string[]> {
  const rows = await db
    .select({ userId: communityThreadParticipant.userId })
    .from(communityThreadParticipant)
    .where(
      and(
        eq(communityThreadParticipant.threadChannelId, threadChannelId),
        eq(communityThreadParticipant.muted, 0)
      )
    );
  return rows.map((r) => r.userId);
}

// Full participant list (incl. muted) hydrated for display — the thread's
// participant panel. `muted` is exposed so the viewer's own row can show a
// muted state.
export async function listThreadParticipants(
  db: Database,
  threadChannelId: string
) {
  return db
    .select({
      userId: communityThreadParticipant.userId,
      source: communityThreadParticipant.source,
      muted: communityThreadParticipant.muted,
      addedAt: communityThreadParticipant.addedAt,
      userName: user.name,
      userImage: user.image,
      discriminator: user.discriminator,
    })
    .from(communityThreadParticipant)
    .innerJoin(user, eq(user.id, communityThreadParticipant.userId))
    .where(eq(communityThreadParticipant.threadChannelId, threadChannelId));
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

// Mute / unmute: keep the row, toggle notification suppression.
export async function setThreadParticipantMuted(
  db: Database,
  threadChannelId: string,
  userId: string,
  muted: boolean
) {
  const rows = await db
    .update(communityThreadParticipant)
    .set({ muted: muted ? 1 : 0 })
    .where(
      and(
        eq(communityThreadParticipant.threadChannelId, threadChannelId),
        eq(communityThreadParticipant.userId, userId)
      )
    )
    .returning();
  return rows[0] ?? null;
}

// Of the given thread ids, which the user participates in with notifications
// enabled (muted = 0). Batch form for the inbox unread-threads filter.
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
        eq(communityThreadParticipant.userId, userId),
        eq(communityThreadParticipant.muted, 0)
      )
    );
  return rows.map((r) => r.threadChannelId);
}

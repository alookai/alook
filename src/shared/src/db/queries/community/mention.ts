import { eq, and, inArray, desc } from "drizzle-orm";
import { communityMention, communityMessage } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function createMentions(
  db: Database,
  data: { messageId: string; userIds: string[]; kind?: "mention" | "reply" }
) {
  if (data.userIds.length === 0) return [];

  const kind = data.kind ?? "mention";
  const rows = await db
    .insert(communityMention)
    .values(
      data.userIds.map((userId) => ({
        messageId: data.messageId,
        userId,
        kind,
      }))
    )
    .returning();
  return rows;
}

export async function listUnreadMentions(
  db: Database,
  userId: string,
  opts: {
    kind?: "mention" | "reply";
    limit?: number;
    /**
     * Scope mentions to channels the viewer may see (scope-first, in-query —
     * NOT a post-fetch filter). Closes the removed-from-private-channel leak:
     * a user @-mentioned in a private channel then removed no longer sees that
     * mention. `NULL IN (...)` is never true in SQL, so DM reply rows
     * (`channelId = NULL`) are naturally excluded — which is intended, the
     * Mentions tab does not surface DM replies. Omitted → no channel scoping
     * (callers that don't need it, e.g. a single-kind agent read).
     */
    visibleChannelIds?: string[];
  } = {}
) {
  const conditions = [
    eq(communityMention.userId, userId),
    eq(communityMention.read, 0),
  ];
  if (opts.kind) conditions.push(eq(communityMention.kind, opts.kind));
  if (opts.visibleChannelIds) {
    conditions.push(inArray(communityMessage.channelId, opts.visibleChannelIds));
  }

  const q = db
    .select({
      mention: communityMention,
      message: communityMessage,
      author: user,
    })
    .from(communityMention)
    .innerJoin(
      communityMessage,
      eq(communityMention.messageId, communityMessage.id)
    )
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    // Deterministic truncation: combining mention + reply kinds under a limit
    // needs an explicit order so the newest mentions win the cap.
    .orderBy(desc(communityMessage.createdAt));

  return opts.limit !== undefined ? q.limit(opts.limit) : q;
}

export async function markMentionsRead(
  db: Database,
  userId: string,
  messageIds: string[]
) {
  if (messageIds.length === 0) return;

  await db
    .update(communityMention)
    .set({ read: 1 })
    .where(
      and(
        eq(communityMention.userId, userId),
        inArray(communityMention.messageId, messageIds)
      )
    );
}

export async function markAllMentionsRead(db: Database, userId: string) {
  await db
    .update(communityMention)
    .set({ read: 1 })
    .where(and(eq(communityMention.userId, userId), eq(communityMention.read, 0)));
}

export async function markChannelMentionsRead(db: Database, userId: string, channelId: string) {
  const mentionIds = await db
    .select({ id: communityMention.id })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMention.messageId, communityMessage.id))
    .where(and(
      eq(communityMention.userId, userId),
      eq(communityMention.read, 0),
      eq(communityMessage.channelId, channelId)
    ));
  if (mentionIds.length === 0) return;
  await db.update(communityMention)
    .set({ read: 1 })
    .where(inArray(communityMention.id, mentionIds.map((r) => r.id)));
}

/**
 * Batch-friendly builder version of `markChannelMentionsRead`. Collapses the
 * two-step "select-ids-then-update" into a single UPDATE with a correlated
 * subquery, so it can be composed into `db.batch([...])`.
 *
 * Note: this always fires the UPDATE — even when there are no matching rows,
 * the statement is a no-op. That's fine for a batch; the batch cost is one
 * round-trip regardless.
 */
export function markChannelMentionsReadBuilder(
  db: Database,
  userId: string,
  channelId: string
) {
  const matchingMentionIds = db
    .select({ id: communityMention.id })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMention.messageId, communityMessage.id))
    .where(
      and(
        eq(communityMention.userId, userId),
        eq(communityMention.read, 0),
        eq(communityMessage.channelId, channelId)
      )
    );

  return db
    .update(communityMention)
    .set({ read: 1 })
    .where(inArray(communityMention.id, matchingMentionIds));
}

export async function deleteMention(db: Database, userId: string, mentionId: string) {
  const rows = await db
    .delete(communityMention)
    .where(
      and(eq(communityMention.id, mentionId), eq(communityMention.userId, userId))
    )
    .returning({ id: communityMention.id });
  return rows.length;
}

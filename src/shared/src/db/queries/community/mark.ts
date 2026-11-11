import { eq, ne, or, isNull, isNotNull, and, count, inArray, desc, asc } from "drizzle-orm";
import { communityMessageMark, communityMessage, communityChannel } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { channelReadableSql } from "./channel";
import { dmPeerReadableSql } from "./dm";
import { formatHandle } from "../../../lib/discriminator";
import type { OtherBotMark } from "../../../community-cli-contract";
import { chunk, D1_MAX_IN_PARAMS, maxInParams } from "../_chunk";

export async function markMessage(
  db: Database,
  data: { userId: string; channelId: string; messageId: string; note?: string | null }
) {
  const insert = db.insert(communityMessageMark).values({
    userId: data.userId,
    channelId: data.channelId,
    messageId: data.messageId,
    note: data.note ?? null,
  });
  const target = [communityMessageMark.userId, communityMessageMark.messageId];
  const mutation = data.note === undefined
    ? insert.onConflictDoNothing({ target })
    : insert.onConflictDoUpdate({
        target,
        set: { note: data.note },
        setWhere: data.note === null
          ? isNotNull(communityMessageMark.note)
          : or(isNull(communityMessageMark.note), ne(communityMessageMark.note, data.note)),
      });
  const [changed] = await mutation.returning();
  return changed ?? null;
}

export async function getMessageMark(db: Database, userId: string, messageId: string) {
  const [mark] = await db
    .select({ id: communityMessageMark.id, note: communityMessageMark.note })
    .from(communityMessageMark)
    .where(and(eq(communityMessageMark.userId, userId), eq(communityMessageMark.messageId, messageId)))
    .limit(1);
  return mark ?? null;
}

// Self-scoped: only the marking user's own row is deletable. A DELETE targeting
// someone else's mark on the same message matches 0 rows (no-op) — never touches
// another user's private mark.
export async function unmarkMessage(
  db: Database,
  data: { userId: string; messageId: string }
) {
  const [deleted] = await db
    .delete(communityMessageMark)
    .where(
      and(
        eq(communityMessageMark.userId, data.userId),
        eq(communityMessageMark.messageId, data.messageId)
      )
    )
    .returning();
  return deleted ?? null;
}

// Single-row presence check for the ⋯-menu Mark/Unmark label. Self-scoped
// (WHERE userId): answers "did *I* mark this", never "did anyone" — reading
// another user's mark state would leak their private marks. Hits
// UNIQUE(userId, messageId), so it's a one-row index lookup.
export async function isMessageMarked(
  db: Database,
  userId: string,
  messageId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: communityMessageMark.id })
    .from(communityMessageMark)
    .where(
      and(
        eq(communityMessageMark.userId, userId),
        eq(communityMessageMark.messageId, messageId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

// Cross-channel Marked list for the inbox tab. Scoped to the viewer's visible
// channels in-query (NOT a post-fetch filter) so a mark in a private channel the
// user has since left never surfaces — same guard as listUnreadMentions. Joins
// communityMessage for the jump key (seq) + snapshot, and user for the author.
// No denormalized seq on the mark row, so the join is required.
export async function listMarksForUser(
  db: Database,
  userId: string,
  opts: { limit?: number; visibleChannelIds?: string[] }
) {
  const runQuery = (extra: ReturnType<typeof inArray>[] = []) => {
    const q = db
      .select({
        mark: communityMessageMark,
        message: communityMessage,
        author: user,
      })
      .from(communityMessageMark)
      .innerJoin(
        communityMessage,
        eq(communityMessageMark.messageId, communityMessage.id)
      )
      .innerJoin(user, eq(communityMessage.authorId, user.id))
      .where(and(eq(communityMessageMark.userId, userId), ...extra))
      // Newest-first — matches idx_mark_user_created.
      .orderBy(desc(communityMessageMark.createdAt));
    return opts.limit !== undefined ? q.limit(opts.limit) : q;
  };

  // The owner-only bot preview reads that bot's marks without a channel filter.
  if (!opts.visibleChannelIds) return runQuery();
  if (opts.visibleChannelIds.length === 0) return [];

  // `visibleChannelIds` is an unbounded authorization scope, so chunk the
  // `inArray` under D1's param cap and merge: each chunk runs the same
  // order+limit, then re-sort by createdAt desc + re-apply the limit so the
  // global newest wins (not each chunk's newest). createdAt is in the
  // projection, so the JS re-sort is exact.
  const chunks = chunk(opts.visibleChannelIds, D1_MAX_IN_PARAMS);
  const merged = (
    await Promise.all(
      chunks.map((ids) =>
        runQuery([inArray(communityMessageMark.channelId, ids)])
      )
    )
  ).flat();
  merged.sort((a, b) => (a.mark.createdAt < b.mark.createdAt ? 1 : -1));
  return opts.limit !== undefined ? merged.slice(0, opts.limit) : merged;
}

export async function countMarksForUser(
  db: Database,
  userId: string,
  opts: { visibleChannelIds: string[] }
): Promise<number> {
  if (opts.visibleChannelIds.length === 0) return 0;

  const counts = await Promise.all(
    chunk(opts.visibleChannelIds, D1_MAX_IN_PARAMS).map(async (ids) => {
      const rows = await db
        .select({ count: count() })
        .from(communityMessageMark)
        .where(
          and(
            eq(communityMessageMark.userId, userId),
            inArray(communityMessageMark.channelId, ids)
          )
        );
      return rows[0]?.count ?? 0;
    })
  );
  return counts.reduce((total, count) => total + count, 0);
}

export async function listOtherBotMarks(
  db: Database,
  viewerId: string,
  messageIds: string[],
): Promise<Map<string, OtherBotMark[]>> {
  const result = new Map<string, OtherBotMark[]>();
  const channel = {
    id: communityChannel.id,
    type: communityChannel.type,
    serverId: communityChannel.serverId,
    parentChannelId: communityChannel.parentChannelId,
  };
  for (const ids of chunk([...new Set(messageIds)], maxInParams(14))) {
    const rows = await db.select({
      messageId: communityMessageMark.messageId,
      botUserId: user.id,
      name: user.name,
      discriminator: user.discriminator,
      note: communityMessageMark.note,
    }).from(communityMessageMark)
      .innerJoin(user, eq(user.id, communityMessageMark.userId))
      .innerJoin(communityMessage, eq(communityMessage.id, communityMessageMark.messageId))
      .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
      .where(and(
        inArray(communityMessageMark.messageId, ids),
        ne(user.id, viewerId),
        eq(user.isBot, true),
        isNull(user.deletedAt),
        channelReadableSql(viewerId, channel),
        channelReadableSql(user.id, channel),
        or(ne(communityChannel.type, "dm"), dmPeerReadableSql(db, viewerId, communityChannel.id)),
      )).orderBy(asc(user.id));
    for (const row of rows) {
      const entries = result.get(row.messageId) ?? [];
      entries.push({ botUserId: row.botUserId, handle: `@${formatHandle(row.name, row.discriminator)}`, note: row.note });
      result.set(row.messageId, entries);
    }
  }
  return result;
}

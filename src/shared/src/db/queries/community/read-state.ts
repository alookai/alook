import { eq, and, inArray, sql } from "drizzle-orm";
import {
  communityReadState,
  communityChannel,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";

function buildTargetFilter(data: {
  userId: string;
  channelId?: string;
  dmConversationId?: string;
}) {
  const conditions = [eq(communityReadState.userId, data.userId)];

  if (data.channelId) {
    conditions.push(eq(communityReadState.channelId, data.channelId));
  }
  if (data.dmConversationId) {
    conditions.push(
      eq(communityReadState.dmConversationId, data.dmConversationId)
    );
  }

  return and(...conditions)!;
}

/**
 * Batch-friendly builder for marking a **channel** read. Returns a builder
 * (not a Promise) so it can be composed into `db.batch([...])`. Uses SQLite's
 * `ON CONFLICT ... DO UPDATE` against the partial unique index
 * `idx_read_state_user_channel` so the upsert is a single statement.
 *
 * Unlike `markRead`, this only handles the channel case — DM reads are a
 * single-write route and don't need batching (see plan #12).
 */
export function markChannelReadBuilder(
  db: Database,
  data: {
    userId: string;
    channelId: string;
    lastReadAt: string;
    lastReadMessageId?: string;
  }
) {
  return db
    .insert(communityReadState)
    .values({
      userId: data.userId,
      channelId: data.channelId,
      dmConversationId: null,
      lastReadAt: data.lastReadAt,
      lastReadMessageId: data.lastReadMessageId ?? null,
    })
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
      targetWhere: sql`${communityReadState.channelId} IS NOT NULL`,
      set: {
        lastReadAt: data.lastReadAt,
        lastReadMessageId: data.lastReadMessageId ?? null,
      },
    });
}

export async function markRead(
  db: Database,
  data: {
    userId: string;
    channelId?: string;
    dmConversationId?: string;
    lastReadAt: string;
    lastReadMessageId?: string;
  }
) {
  const existing = await db
    .select()
    .from(communityReadState)
    .where(buildTargetFilter(data));

  if (existing.length > 0) {
    const [updated] = await db
      .update(communityReadState)
      .set({
        lastReadAt: data.lastReadAt,
        lastReadMessageId: data.lastReadMessageId ?? null,
      })
      .where(eq(communityReadState.id, existing[0]!.id))
      .returning();
    return updated!;
  }

  const [inserted] = await db
    .insert(communityReadState)
    .values({
      userId: data.userId,
      channelId: data.channelId ?? null,
      dmConversationId: data.dmConversationId ?? null,
      lastReadAt: data.lastReadAt,
      lastReadMessageId: data.lastReadMessageId ?? null,
    })
    .returning();
  return inserted!;
}

/**
 * Mark every top-level channel in every server the user is a member of as
 * read at `now`. Used by the inbox's global "Mark all read". Upserts in a
 * single batch — preserves existing rows by id, inserts a new row otherwise.
 */
export async function markAllServerChannelsRead(
  db: Database,
  userId: string
): Promise<number> {
  const now = new Date().toISOString();

  const channelRows = await db
    .select({ channelId: communityChannel.id })
    .from(communityServerMember)
    .innerJoin(
      communityChannel,
      eq(communityChannel.serverId, communityServerMember.serverId)
    )
    .where(eq(communityServerMember.userId, userId));

  const channelIds = channelRows.map((r) => r.channelId);
  if (channelIds.length === 0) return 0;

  // Existing read_state rows for these channels.
  const existing = await db
    .select({
      id: communityReadState.id,
      channelId: communityReadState.channelId,
    })
    .from(communityReadState)
    .where(
      and(
        eq(communityReadState.userId, userId),
        inArray(communityReadState.channelId, channelIds)
      )
    );
  const existingIds = new Set(
    existing.map((r) => r.channelId).filter((id): id is string => !!id)
  );

  if (existing.length > 0) {
    await db
      .update(communityReadState)
      .set({ lastReadAt: now })
      .where(
        and(
          eq(communityReadState.userId, userId),
          inArray(communityReadState.channelId, channelIds)
        )
      );
  }

  const toInsert = channelIds.filter((id) => !existingIds.has(id));
  if (toInsert.length > 0) {
    await db.insert(communityReadState).values(
      toInsert.map((channelId) => ({
        userId,
        channelId,
        dmConversationId: null,
        lastReadAt: now,
        lastReadMessageId: null,
      }))
    );
  }

  return channelIds.length;
}

export async function getReadState(
  db: Database,
  data: {
    userId: string;
    channelId?: string;
    dmConversationId?: string;
  }
) {
  const rows = await db
    .select()
    .from(communityReadState)
    .where(buildTargetFilter(data));
  return rows[0] ?? null;
}

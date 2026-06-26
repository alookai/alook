import { eq, and } from "drizzle-orm";
import { communityReadState } from "../../community-schema";
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

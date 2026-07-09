import { eq, and, or, isNotNull, inArray } from "drizzle-orm";
import { communityNotificationSetting } from "../../community-schema";
import type { Database } from "../../index";

export async function getMutedUserIds(
  db: Database,
  userIds: string[],
  opts: { channelId?: string; serverId?: string }
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()

  const rows = await db
    .select({
      userId: communityNotificationSetting.userId,
      channelId: communityNotificationSetting.channelId,
      serverId: communityNotificationSetting.serverId,
      level: communityNotificationSetting.level,
    })
    .from(communityNotificationSetting)
    .where(and(
      inArray(communityNotificationSetting.userId, userIds),
      or(
        opts.channelId ? eq(communityNotificationSetting.channelId, opts.channelId) : undefined,
        opts.serverId ? and(eq(communityNotificationSetting.serverId, opts.serverId), isNotNull(communityNotificationSetting.serverId)) : undefined,
      ),
    ))

  const muted = new Set<string>()
  for (const uid of userIds) {
    const userRows = rows.filter((r) => r.userId === uid)
    const channelSetting = userRows.find((r) => r.channelId != null)
    const serverSetting = userRows.find((r) => r.serverId != null)
    const effective = channelSetting ?? serverSetting
    if (effective?.level === "nothing") muted.add(uid)
  }
  return muted
}

export async function getSettings(db: Database, userId: string) {
  return db
    .select()
    .from(communityNotificationSetting)
    .where(eq(communityNotificationSetting.userId, userId));
}

export async function setServerLevel(
  db: Database,
  data: { userId: string; serverId: string; level: string }
) {
  const existing = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.serverId, data.serverId),
        isNotNull(communityNotificationSetting.serverId)
      )
    );

  if (existing.length > 0) {
    const [updated] = await db
      .update(communityNotificationSetting)
      .set({ level: data.level })
      .where(eq(communityNotificationSetting.id, existing[0]!.id))
      .returning();
    return updated!;
  }

  const [inserted] = await db
    .insert(communityNotificationSetting)
    .values({
      userId: data.userId,
      serverId: data.serverId,
      channelId: null,
      level: data.level,
    })
    .returning();
  return inserted!;
}

export async function setChannelLevel(
  db: Database,
  data: { userId: string; channelId: string; level: string }
) {
  const existing = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.channelId, data.channelId),
        isNotNull(communityNotificationSetting.channelId)
      )
    );

  if (existing.length > 0) {
    const [updated] = await db
      .update(communityNotificationSetting)
      .set({ level: data.level })
      .where(eq(communityNotificationSetting.id, existing[0]!.id))
      .returning();
    return updated!;
  }

  const [inserted] = await db
    .insert(communityNotificationSetting)
    .values({
      userId: data.userId,
      serverId: null,
      channelId: data.channelId,
      level: data.level,
    })
    .returning();
  return inserted!;
}

export async function removeChannelOverride(
  db: Database,
  data: { userId: string; channelId: string }
) {
  const [deleted] = await db
    .delete(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.channelId, data.channelId),
        isNotNull(communityNotificationSetting.channelId)
      )
    )
    .returning();
  return deleted ?? null;
}

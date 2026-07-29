import { eq, and, or, isNull, isNotNull, inArray } from "drizzle-orm";
import { communityNotificationSetting, communityChannel } from "../../community-schema";
import type { Database } from "../../index";
import type { NotificationLevelValue } from "../../../constants/community";

type EffectiveLevelChannel = {
  id: string;
  serverId: string;
  parentChannelId: string | null;
};

type EffectiveLevelSetting = {
  channelId: string | null;
  serverId: string | null;
  level: string;
};

// Resolve a user's effective notification level for a channel: own-channel
// override beats parent-channel (forum/thread → its parent) beats server
// default beats the global default "all". A DM channel has serverId null and no
// parent, so it matches none of the fallbacks and lands on its OWN setting or
// the "all" default — a DM's level is self-contained, never inherited from a
// server/parent (a `nothing` set elsewhere can't cascade onto a DM).
export function computeEffectiveLevel(
  settings: EffectiveLevelSetting[],
  channel: EffectiveLevelChannel
): NotificationLevelValue {
  const own = settings.find((s) => s.channelId === channel.id);
  if (own) return own.level as NotificationLevelValue;

  if (channel.parentChannelId) {
    const parent = settings.find((s) => s.channelId === channel.parentChannelId);
    if (parent) return parent.level as NotificationLevelValue;
  }

  const server = settings.find(
    (s) => s.channelId == null && s.serverId === channel.serverId
  );
  if (server) return server.level as NotificationLevelValue;

  return "all";
}

async function loadChannel(
  db: Database,
  channelId: string
): Promise<EffectiveLevelChannel | null> {
  const rows = await db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      parentChannelId: communityChannel.parentChannelId,
    })
    .from(communityChannel)
    .where(eq(communityChannel.id, channelId));
  return rows[0] ?? null;
}

async function loadScopedSettings(
  db: Database,
  userIds: string[],
  channel: EffectiveLevelChannel
): Promise<(EffectiveLevelSetting & { userId: string })[]> {
  const channelIds = channel.parentChannelId
    ? [channel.id, channel.parentChannelId]
    : [channel.id];

  return db
    .select({
      userId: communityNotificationSetting.userId,
      channelId: communityNotificationSetting.channelId,
      serverId: communityNotificationSetting.serverId,
      level: communityNotificationSetting.level,
    })
    .from(communityNotificationSetting)
    .where(
      and(
        inArray(communityNotificationSetting.userId, userIds),
        or(
          inArray(communityNotificationSetting.channelId, channelIds),
          and(
            eq(communityNotificationSetting.serverId, channel.serverId),
            isNull(communityNotificationSetting.channelId)
          )
        )
      )
    );
}

export async function resolveEffectiveLevel(
  db: Database,
  userId: string,
  channelId: string
): Promise<NotificationLevelValue> {
  const channel = await loadChannel(db, channelId);
  if (!channel) return "all";
  const settings = await loadScopedSettings(db, [userId], channel);
  return computeEffectiveLevel(settings, channel);
}

// Batch resolver: 2 queries total (one channel load + one scoped settings
// fetch) regardless of recipient count.
export async function resolveEffectiveLevelForUsers(
  db: Database,
  userIds: string[],
  channelId: string
): Promise<Map<string, NotificationLevelValue>> {
  const result = new Map<string, NotificationLevelValue>();
  if (userIds.length === 0) return result;

  const channel = await loadChannel(db, channelId);
  if (!channel) {
    for (const uid of userIds) result.set(uid, "all");
    return result;
  }

  const rows = await loadScopedSettings(db, userIds, channel);
  for (const uid of userIds) {
    const userSettings = rows.filter((r) => r.userId === uid);
    result.set(uid, computeEffectiveLevel(userSettings, channel));
  }
  return result;
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

import {
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  gt,
  exists,
  notExists,
  sql,
} from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
  communityNotificationSetting,
  communityChannel,
  communityCategory,
  communityChannelMember,
  communityMessage,
  communityReadState,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import {
  accountReadStateRevisionBuilder,
  advanceReadStateRevisionWhenBuilder,
} from "./read-state";
import type { NotificationLevelValue } from "../../../constants/community";
import { currentEffectiveLevelSql } from "./notification-eligibility";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";

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

export function policyAllows(
  level: NotificationLevelValue,
  hasAttention: boolean,
): boolean {
  if (level === "nothing") return false;
  return level === "all" || hasAttention;
}

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

  // Reserve one bind for serverId plus one per own/parent channel id. The
  // remainder is the safe recipient batch under D1's 100-bind ceiling.
  const usersPerQuery = D1_MAX_IN_PARAMS - channelIds.length - 1;
  const rows = await Promise.all(
    chunk(userIds, usersPerQuery).map((ids) =>
      db
        .select({
          userId: communityNotificationSetting.userId,
          channelId: communityNotificationSetting.channelId,
          serverId: communityNotificationSetting.serverId,
          level: communityNotificationSetting.level,
        })
        .from(communityNotificationSetting)
        .where(
          and(
            inArray(communityNotificationSetting.userId, ids),
            or(
              inArray(communityNotificationSetting.channelId, channelIds),
              and(
                eq(communityNotificationSetting.serverId, channel.serverId),
                isNull(communityNotificationSetting.channelId)
              )
            )
          )
        )
    )
  );
  return rows.flat();
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

// Batch resolver: one channel load plus one bounded settings query per D1-safe
// recipient chunk. This is O(chunks), never N+1.
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

export async function getServerSetting(
  db: Database,
  userId: string,
  serverId: string,
) {
  const rows = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, userId),
        eq(communityNotificationSetting.serverId, serverId),
        isNull(communityNotificationSetting.channelId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getChannelSetting(
  db: Database,
  userId: string,
  channelId: string,
) {
  const rows = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, userId),
        eq(communityNotificationSetting.channelId, channelId),
        isNull(communityNotificationSetting.serverId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

type MutationScope =
  | { kind: "server"; id: string }
  | { kind: "channel"; id: string };

type SettingChange =
  | { kind: "set-server"; id: string; level: string }
  | { kind: "set-channel"; id: string; level: string }
  | { kind: "remove-channel"; id: string };

function affectedChannelWhere(scope: MutationScope) {
  return scope.kind === "server"
    ? eq(communityChannel.serverId, scope.id)
    : or(
        eq(communityChannel.id, scope.id),
        eq(communityChannel.parentChannelId, scope.id),
      )!;
}

/** The target identity must be able to read every channel whose cursor moves. */
function userCanAccessChannelSql(userId: string) {
  const anchorId = sql`coalesce(${communityChannel.parentChannelId}, ${communityChannel.id})`;
  const anchorPrivate = sql<number>`coalesce((
    select ${communityCategory.private}
    from ${communityChannel} notification_anchor
    left join ${communityCategory}
      on ${communityCategory.id} = notification_anchor.category_id
    where notification_anchor.id = ${anchorId}
    limit 1
  ), 0)`;
  const anchorCreator = sql`(
    select notification_anchor.creator_id
    from ${communityChannel} notification_anchor
    where notification_anchor.id = ${anchorId}
    limit 1
  )`;
  const hasChannelAccess = sql<boolean>`exists(
    select 1 from ${communityChannelMember}
    where ${communityChannelMember.channelId} = ${anchorId}
      and ${communityChannelMember.userId} = ${userId}
      and ${communityChannelMember.relation} = 'access'
  )`;
  const hasServerMembership = sql<boolean>`exists(
    select 1 from ${communityServerMember}
    where ${communityServerMember.serverId} = ${communityChannel.serverId}
      and ${communityServerMember.userId} = ${userId}
  )`;

  return sql<boolean>`case
    when ${communityChannel.serverId} is null then ${hasChannelAccess}
    else ${hasServerMembership} and (
      ${anchorPrivate} = 0
      or ${anchorCreator} = ${userId}
      or ${hasChannelAccess}
    )
  end`;
}

function settingLevelForChannelSql(
  userId: string,
  channelId: SQLWrapper,
  extraWhere?: ReturnType<typeof sql>,
) {
  return sql`(
    select ${communityNotificationSetting.level}
    from ${communityNotificationSetting}
    where ${communityNotificationSetting.userId} = ${userId}
      and ${communityNotificationSetting.channelId} = ${channelId}
      ${extraWhere ? sql`and ${extraWhere}` : sql``}
    limit 1
  )`;
}

function serverLevelSql(userId: string) {
  return sql`(
    select ${communityNotificationSetting.level}
    from ${communityNotificationSetting}
    where ${communityNotificationSetting.userId} = ${userId}
      and ${communityNotificationSetting.serverId} = ${communityChannel.serverId}
      and ${communityNotificationSetting.channelId} is null
    limit 1
  )`;
}

/** Effective level each affected channel will have after the requested write. */
function nextEffectiveLevelSql(userId: string, change: SettingChange) {
  if (change.kind === "set-server") {
    return sql<NotificationLevelValue>`coalesce(
      ${settingLevelForChannelSql(userId, communityChannel.id)},
      ${settingLevelForChannelSql(userId, communityChannel.parentChannelId)},
      ${change.level}
    )`;
  }

  if (change.kind === "set-channel") {
    return sql<NotificationLevelValue>`case
      when ${communityChannel.id} = ${change.id} then ${change.level}
      else coalesce(
        ${settingLevelForChannelSql(userId, communityChannel.id)},
        ${change.level}
      )
    end`;
  }

  // Remove the target override from the resolver without actually deleting it
  // yet. For the target, its direct parent remains eligible inheritance; for
  // a child, parentChannelId === target and must be excluded as the row being
  // removed. A child's own override still wins and therefore yields no change.
  return sql<NotificationLevelValue>`coalesce(
    ${settingLevelForChannelSql(
      userId,
      communityChannel.id,
      sql`${communityChannel.id} <> ${change.id}`,
    )},
    ${settingLevelForChannelSql(
      userId,
      communityChannel.parentChannelId,
      sql`${communityChannel.parentChannelId} <> ${change.id}`,
    )},
    ${serverLevelSql(userId)},
    'all'
  )`;
}

/**
 * Build the cursor half of a notification-setting mutation.
 *
 * The product contract treats a setting change as handling every old unread
 * in the affected scope. The statement selects each channel's latest real
 * message and advances all three aligned read-state fields together. Empty
 * channels produce no row, while the conflict guard prevents a concurrent or
 * already-newer cursor from regressing.
 */
function buildClearAffectedUnreadStatement(
  db: Database,
  userId: string,
  change: SettingChange,
) {
  const scope: MutationScope = change.kind === "set-server"
    ? { kind: "server", id: change.id }
    : { kind: "channel", id: change.id };
  const latestMessage = alias(communityMessage, "notification_latest_message");
  const newerMessage = alias(communityMessage, "notification_newer_message");
  const channelSql = {
    id: communityChannel.id,
    serverId: communityChannel.serverId,
    parentChannelId: communityChannel.parentChannelId,
  };
  const currentLevel = currentEffectiveLevelSql(userId, channelSql);
  const nextLevel = nextEffectiveLevelSql(userId, change);
  const selected = db
    .select({
      id: sql<string>`lower(hex(randomblob(16)))`.as("id"),
      userId: sql<string>`${userId}`.as("user_id"),
      channelId: communityChannel.id,
      lastReadAt: latestMessage.createdAt,
      lastReadMessageId: latestMessage.id,
      lastReadSeq: latestMessage.seq,
    })
    .from(communityChannel)
    .innerJoin(
      latestMessage,
      eq(latestMessage.channelId, communityChannel.id),
    )
    .where(
      and(
        affectedChannelWhere(scope),
        userCanAccessChannelSql(userId),
        sql`${currentLevel} <> ${nextLevel}`,
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(newerMessage)
            .where(
              and(
                eq(newerMessage.channelId, latestMessage.channelId),
                gt(newerMessage.seq, latestMessage.seq),
              ),
            ),
        ),
      ),
    );

  return db
    .insert(communityReadState)
    .select(selected)
    .onConflictDoUpdate({
      target: [communityReadState.userId, communityReadState.channelId],
      set: {
        lastReadAt: sql`excluded.last_read_at`,
        lastReadMessageId: sql`excluded.last_read_message_id`,
        lastReadSeq: sql`excluded.last_read_seq`,
      },
      setWhere: sql`${communityReadState.lastReadSeq} < excluded.last_read_seq`,
    });
}

function effectivePolicyChangesCondition(
  db: Database,
  userId: string,
  change: SettingChange,
) {
  const scope: MutationScope = change.kind === "set-server"
    ? { kind: "server", id: change.id }
    : { kind: "channel", id: change.id };
  const channelSql = {
    id: communityChannel.id,
    serverId: communityChannel.serverId,
    parentChannelId: communityChannel.parentChannelId,
  };
  return exists(db
    .select({ one: sql<number>`1` })
    .from(communityChannel)
    .where(
      and(
        affectedChannelWhere(scope),
        userCanAccessChannelSql(userId),
        sql`${currentEffectiveLevelSql(userId, channelSql)} <> ${nextEffectiveLevelSql(userId, change)}`,
      ),
    ));
}

async function applySettingMutation(
  db: Database,
  userId: string,
  change: SettingChange,
  mutation: unknown,
  actorKind: "human" | "bot",
): Promise<number | null> {
  // Clear first while the current projection still represents the "before"
  // level used by the changed-effective predicate. D1 batch is atomic, so no
  // observer can see the cursor advance without the setting write (or vice
  // versa), and any failure rolls both statements back.
  const clearUnread = buildClearAffectedUnreadStatement(db, userId, change);
  if (actorKind === "bot") {
    await db.batch([clearUnread, mutation] as any);
    return null;
  }
  const effectChanges = effectivePolicyChangesCondition(db, userId, change);
  const results = await db.batch([
    advanceReadStateRevisionWhenBuilder(db, userId, effectChanges),
    clearUnread,
    mutation,
    accountReadStateRevisionBuilder(db, userId),
  ] as any) as unknown[];
  const changed = (results[0] as Array<{ revision: number }>).length > 0;
  const revision = (results[3] as Array<{ revision: number }>)[0]?.revision ?? 0;
  return changed ? revision : null;
}

export async function setServerLevel(
  db: Database,
  data: { userId: string; serverId: string; level: string; actorKind: "human" | "bot" }
) {
  const mutation = db
    .insert(communityNotificationSetting)
    .values({
      id: nanoid(),
      userId: data.userId,
      serverId: data.serverId,
      channelId: null,
      level: data.level,
    })
    .onConflictDoUpdate({
      target: [
        communityNotificationSetting.userId,
        communityNotificationSetting.serverId,
      ],
      targetWhere: isNotNull(communityNotificationSetting.serverId),
      set: { level: data.level },
    });

  const readStateRevision = await applySettingMutation(
    db,
    data.userId,
    { kind: "set-server", id: data.serverId, level: data.level },
    mutation,
    data.actorKind,
  );

  const rows = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.serverId, data.serverId),
        isNull(communityNotificationSetting.channelId),
      ),
    )
    .limit(1);
  return { setting: rows[0]!, readStateRevision };
}

export async function setChannelLevel(
  db: Database,
  data: { userId: string; channelId: string; level: string; actorKind: "human" | "bot" }
) {
  const mutation = db
    .insert(communityNotificationSetting)
    .values({
      id: nanoid(),
      userId: data.userId,
      serverId: null,
      channelId: data.channelId,
      level: data.level,
    })
    .onConflictDoUpdate({
      target: [
        communityNotificationSetting.userId,
        communityNotificationSetting.channelId,
      ],
      targetWhere: isNotNull(communityNotificationSetting.channelId),
      set: { level: data.level },
    });

  const readStateRevision = await applySettingMutation(
    db,
    data.userId,
    { kind: "set-channel", id: data.channelId, level: data.level },
    mutation,
    data.actorKind,
  );

  const rows = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.channelId, data.channelId),
        isNull(communityNotificationSetting.serverId),
      ),
    )
    .limit(1);
  return { setting: rows[0]!, readStateRevision };
}

export async function removeChannelOverride(
  db: Database,
  data: { userId: string; channelId: string; actorKind: "human" | "bot" }
) {
  const existingRows = await db
    .select()
    .from(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.channelId, data.channelId),
        isNotNull(communityNotificationSetting.channelId),
      ),
    )
    .limit(1);

  const mutation = db
    .delete(communityNotificationSetting)
    .where(
      and(
        eq(communityNotificationSetting.userId, data.userId),
        eq(communityNotificationSetting.channelId, data.channelId),
        isNotNull(communityNotificationSetting.channelId)
      )
    );

  const readStateRevision = await applySettingMutation(
    db,
    data.userId,
    { kind: "remove-channel", id: data.channelId },
    mutation,
    data.actorKind,
  );
  return { setting: existingRows[0] ?? null, readStateRevision };
}

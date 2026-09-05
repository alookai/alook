import type { CommunityReplicaScope } from "../../../community/replica";
import { asc, eq } from "drizzle-orm";
import { communityCategory } from "../../community-schema";
import type { Database } from "../../index";
import { getReplicaScopeRevisions } from "./replica-store";
import * as channelQueries from "./channel";
import * as inboxQueries from "./inbox";
import * as messageQueries from "./message";
import * as readStateQueries from "./read-state";
import * as serverQueries from "./server";

export type ReplicaBootstrapTailRequest = { channelId: string; limit: number };

export async function loadReplicaBootstrapRows(
  db: Database,
  userId: string,
  serverId: string,
  tails: ReplicaBootstrapTailRequest[],
) {
  const [
    servers,
    mentionSources,
    allVisibleChannelIds,
    serverVisibleChannelIds,
    categories,
    channels,
    readStateSnapshot,
    messageTails,
  ] = await Promise.all([
    serverQueries.listUserServers(db, userId),
    serverQueries.listUnreadMentionSources(db, userId),
    channelQueries.listVisibleChannelIdsForUser(db, userId),
    channelQueries.listVisibleChannelIds(db, serverId, userId),
    db.select({
      id: communityCategory.id,
      serverId: communityCategory.serverId,
      name: communityCategory.name,
      position: communityCategory.position,
      private: communityCategory.private,
      creatorId: communityCategory.creatorId,
    }).from(communityCategory)
      .where(eq(communityCategory.serverId, serverId))
      .orderBy(asc(communityCategory.position), asc(communityCategory.id)),
    channelQueries.listServerChannelsForViewer(db, serverId, userId),
    readStateQueries.getAccountReadStateSnapshot(db, userId),
    Promise.all(tails.map(async (tail) => {
      const rows = await messageQueries.listMessages(db, {
        channelId: tail.channelId,
        limit: tail.limit + 1,
      });
      const hasOlder = rows.length > tail.limit;
      return {
        channelId: tail.channelId,
        rows: (hasOlder ? rows.slice(0, tail.limit) : rows).reverse(),
        hasOlder,
      };
    })),
  ]);
  const [accountUnread, serverUnread] = await Promise.all([
    inboxQueries.listEligibleUnreadChannels(db, userId, allVisibleChannelIds),
    inboxQueries.listEligibleUnreadChannels(db, userId, serverVisibleChannelIds),
  ]);
  const forumParentIds = serverUnread
    .filter((row) => !row.parentChannelId && row.type === "forum")
    .map((row) => row.channelId);
  const unreadOpeners = await inboxQueries.listUnreadForumOpeners(db, userId, forumParentIds);
  const forumParentsWithUnread = new Set([
    ...unreadOpeners.map((row) => row.forumChannelId),
    ...serverUnread.flatMap((row) => row.parentChannelId ? [row.parentChannelId] : []),
  ]);
  const projectedServerUnread = serverUnread.filter((row) => (
    row.parentChannelId
    || row.type !== "forum"
    || forumParentsWithUnread.has(row.channelId)
  ));
  const visible = new Set(allVisibleChannelIds);
  return {
    servers,
    mentionSources,
    accountUnread,
    categories,
    channels,
    serverUnread: projectedServerUnread,
    readStates: readStateSnapshot.readStates.filter((row) => visible.has(row.channelId)),
    messageTails,
  };
}

export async function readStableReplicaSnapshot<T>(
  db: Database,
  scopes: CommunityReplicaScope[],
  load: () => Promise<T>,
  maxAttempts = 3,
): Promise<{ frontier: Awaited<ReturnType<typeof getReplicaScopeRevisions>>; value: T }> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await getReplicaScopeRevisions(db, scopes);
    const value = await load();
    const after = await getReplicaScopeRevisions(db, scopes);
    if (JSON.stringify(before) === JSON.stringify(after)) return { frontier: after, value };
  }
  throw new Error("Replica snapshot changed while it was being read");
}

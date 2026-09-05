import type { CommunityReplicaFrontier } from "../../../community/replica";
import { MENTION_KIND } from "../../../constants/community";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  communityCategory,
  communityChannel,
  communityMention,
  communityMessage,
  communityReadState,
  communityServer,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";
import { chunk, D1_MAX_IN_PARAMS, maxInParams } from "../_chunk";
import { channelReadableSql } from "./channel";
import { getReplicaScopeRevisions, listReplicaDeltaRows, type ReplicaDeltaRow } from "./replica-store";
import * as channelQueries from "./channel";
import * as inboxQueries from "./inbox";
import { notificationEligibleSql } from "./notification-eligibility";

export type ReplicaDeltaWindow =
  | { status: "ok"; rows: ReplicaDeltaRow[]; frontier: CommunityReplicaFrontier; hasMore: boolean }
  | { status: "rebootstrap"; scopes: CommunityReplicaFrontier[number]["scope"][] };

export async function loadReplicaAccountServers(
  db: Database,
  userId: string,
  serverIds: string[],
) {
  const ids = [...new Set(serverIds)];
  if (ids.length === 0) return [];
  const servers = (await Promise.all(chunk(ids, maxInParams(1)).map((part) => db
    .select({
      id: communityServer.id,
      name: communityServer.name,
      discriminator: communityServer.discriminator,
      description: communityServer.description,
      icon: communityServer.icon,
      ownerId: communityServer.ownerId,
      role: communityServerMember.role,
      railOrder: communityServerMember.railOrder,
    })
    .from(communityServer)
    .innerJoin(communityServerMember, and(
      eq(communityServerMember.serverId, communityServer.id),
      eq(communityServerMember.userId, userId),
    ))
    .where(inArray(communityServer.id, part))
    .orderBy(asc(communityServerMember.railOrder), asc(communityServer.id)))))
    .flat();
  if (servers.length === 0) return [];

  const visibleIds = (await Promise.all(servers.map((server) => (
    channelQueries.listVisibleChannelIds(db, server.id, userId)
  )))).flat();
  const unreadRows = await inboxQueries.listEligibleUnreadChannels(db, userId, visibleIds);
  const mentionRows = (await Promise.all(chunk(servers.map((server) => server.id), D1_MAX_IN_PARAMS).map((part) => db
    .select({
      serverId: communityChannel.serverId,
      channelId: communityChannel.id,
      count: count().as("count"),
      lastSeq: sql<number>`MAX(${communityMessage.seq})`.mapWith(Number),
    })
    .from(communityMention)
    .innerJoin(communityMessage, eq(communityMessage.id, communityMention.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .leftJoin(communityReadState, and(
      eq(communityReadState.userId, userId),
      eq(communityReadState.channelId, communityChannel.id),
    ))
    .where(and(
      eq(communityMention.userId, userId),
      eq(communityMention.read, 0),
      eq(communityMention.kind, MENTION_KIND.MENTION),
      inArray(communityChannel.serverId, part),
      sql`${communityMessage.seq} > COALESCE(${communityReadState.lastReadSeq}, 0)`,
      channelReadableSql(userId, {
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      }),
      notificationEligibleSql(
        userId,
        {
          id: communityChannel.id,
          serverId: communityChannel.serverId,
          parentChannelId: communityChannel.parentChannelId,
        },
        { id: communityMessage.id },
      ),
    ))
    .groupBy(communityChannel.serverId, communityChannel.id))))
    .flat();

  return servers.map((server) => {
    const unreadSources = unreadRows
      .filter((row) => row.serverId === server.id)
      .map((row) => ({ channelId: row.channelId, lastUnreadSeq: row.lastUnreadSeq }));
    const mentionSources = mentionRows
      .filter((row) => row.serverId === server.id)
      .map((row) => ({ channelId: row.channelId, count: row.count, lastSeq: row.lastSeq }));
    return {
      ...server,
      unreadSources,
      mentionSources,
      mentions: mentionSources.reduce((total, source) => total + source.count, 0),
    };
  });
}

export async function loadReplicaReadStates(
  db: Database,
  userId: string,
  channelIds: string[],
) {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return [];
  return (await Promise.all(chunk(ids, D1_MAX_IN_PARAMS).map((part) => db
    .select({
      channelId: communityReadState.channelId,
      lastReadMessageId: communityReadState.lastReadMessageId,
      lastReadAt: communityReadState.lastReadAt,
      lastReadSeq: communityReadState.lastReadSeq,
    })
    .from(communityReadState)
    .innerJoin(communityChannel, eq(communityChannel.id, communityReadState.channelId))
    .where(and(
      eq(communityReadState.userId, userId),
      inArray(communityReadState.channelId, part),
      channelReadableSql(userId, {
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      }),
    )))))
    .flat();
}

export async function loadReplicaCategories(
  db: Database,
  serverId: string,
  categoryIds: string[],
) {
  const ids = [...new Set(categoryIds)];
  if (ids.length === 0) return [];
  return (await Promise.all(chunk(ids, maxInParams(1)).map((part) => db
    .select({
      id: communityCategory.id,
      serverId: communityCategory.serverId,
      name: communityCategory.name,
      position: communityCategory.position,
      private: communityCategory.private,
      creatorId: communityCategory.creatorId,
    })
    .from(communityCategory)
    .where(and(
      eq(communityCategory.serverId, serverId),
      inArray(communityCategory.id, part),
    ))
    .orderBy(asc(communityCategory.position), asc(communityCategory.id)))))
    .flat();
}

export async function listReplicaCategoryChannelIds(
  db: Database,
  serverId: string,
  categoryIds: string[],
) {
  const ids = [...new Set(categoryIds)];
  if (ids.length === 0) return [];
  return (await Promise.all(chunk(ids, maxInParams(1)).map((part) => db
    .select({
      categoryId: communityChannel.categoryId,
      channelId: communityChannel.id,
    })
    .from(communityChannel)
    .where(and(
      eq(communityChannel.serverId, serverId),
      isNull(communityChannel.parentChannelId),
      inArray(communityChannel.categoryId, part),
    )))))
    .flat()
    .filter((row): row is { categoryId: string; channelId: string } => row.categoryId !== null);
}

export async function loadReplicaChannels(
  db: Database,
  userId: string,
  serverId: string,
  channelIds: string[],
) {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return [];
  return (await Promise.all(chunk(ids, D1_MAX_IN_PARAMS).map((part) => db
    .select({
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      categoryId: communityChannel.categoryId,
      name: communityChannel.name,
      position: communityChannel.position,
      type: communityChannel.type,
      creatorId: communityChannel.creatorId,
    })
    .from(communityChannel)
    .where(and(
      eq(communityChannel.serverId, serverId),
      isNull(communityChannel.parentChannelId),
      inArray(communityChannel.id, part),
      channelReadableSql(userId, {
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      }),
    ))
    .orderBy(asc(communityChannel.position), asc(communityChannel.id)))))
    .flat();
}

export async function loadReplicaUnreadSources(
  db: Database,
  userId: string,
  serverId: string,
  channelIds: string[],
) {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return [];
  const visibleIds = (await Promise.all(chunk(ids, D1_MAX_IN_PARAMS).map((part) => db
    .select({ id: communityChannel.id })
    .from(communityChannel)
    .where(and(
      eq(communityChannel.serverId, serverId),
      inArray(communityChannel.id, part),
      channelReadableSql(userId, {
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      }),
    )))))
    .flat()
    .map((row) => row.id);
  const unread = await inboxQueries.listEligibleUnreadChannels(db, userId, visibleIds);
  const forumParentIds = unread
    .filter((row) => !row.parentChannelId && row.type === "forum")
    .map((row) => row.channelId);
  const unreadOpeners = await inboxQueries.listUnreadForumOpeners(db, userId, forumParentIds);
  const forumParentsWithUnread = new Set([
    ...unreadOpeners.map((row) => row.forumChannelId),
    ...unread.flatMap((row) => row.parentChannelId ? [row.parentChannelId] : []),
  ]);
  const projected = unread.filter((row) => (
    row.parentChannelId
    || row.type !== "forum"
    || forumParentsWithUnread.has(row.channelId)
  ));
  const byChannel = new Map(projected.map((row) => [row.channelId, row]));
  return visibleIds.map((channelId) => ({
    channelId,
    value: byChannel.get(channelId) ?? null,
  }));
}

export async function readReplicaDeltaWindow(
  db: Database,
  from: CommunityReplicaFrontier,
  limit: number,
): Promise<ReplicaDeltaWindow> {
  const current = await getReplicaScopeRevisions(db, from.map((entry) => entry.scope));
  const currentByScope = new Map(current.map((entry) => [
    `${entry.scope.kind}:${entry.scope.id}`,
    entry.revision,
  ]));
  const invalid = from.filter((entry) => {
    const revision = currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0;
    return entry.revision > revision;
  }).map((entry) => entry.scope);
  if (invalid.length > 0) return { status: "rebootstrap", scopes: invalid };

  const rowsByScope: ReplicaDeltaRow[][] = [];
  for (const entry of from) {
    const currentRevision = currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0;
    if (entry.revision === currentRevision) continue;
    // `limit` counts causal batches, not individual scope deltas. Read the
    // same bounded prefix from every covered scope so one causal commit can
    // never be split at the response boundary.
    const scopeRows = await listReplicaDeltaRows(db, entry.scope, entry.revision, limit + 1);
    if (scopeRows[0]?.revision !== entry.revision + 1) {
      return { status: "rebootstrap", scopes: [entry.scope] };
    }
    for (let index = 1; index < scopeRows.length; index += 1) {
      if (scopeRows[index]!.revision !== scopeRows[index - 1]!.revision + 1) {
        return { status: "rebootstrap", scopes: [entry.scope] };
      }
    }
    rowsByScope.push(scopeRows);
  }

  const causalRows = new Map<string, ReplicaDeltaRow[]>();
  const causalOrder = new Map<string, { committedAt: string; causalId: string }>();
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const scopeRows of rowsByScope) {
    for (const row of scopeRows) {
      const grouped = causalRows.get(row.causalId) ?? [];
      grouped.push(row);
      causalRows.set(row.causalId, grouped);
      const existing = causalOrder.get(row.causalId);
      if (!existing || row.committedAt < existing.committedAt) {
        causalOrder.set(row.causalId, { committedAt: row.committedAt, causalId: row.causalId });
      }
      indegree.set(row.causalId, indegree.get(row.causalId) ?? 0);
    }
    for (let index = 1; index < scopeRows.length; index += 1) {
      const before = scopeRows[index - 1]!.causalId;
      const after = scopeRows[index]!.causalId;
      if (before === after) continue;
      const edges = outgoing.get(before) ?? new Set<string>();
      if (!edges.has(after)) {
        edges.add(after);
        outgoing.set(before, edges);
        indegree.set(after, (indegree.get(after) ?? 0) + 1);
      }
    }
  }

  const compareCausal = (left: string, right: string) => {
    const a = causalOrder.get(left)!;
    const b = causalOrder.get(right)!;
    return a.committedAt.localeCompare(b.committedAt) || a.causalId.localeCompare(b.causalId);
  };
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([causalId]) => causalId)
    .sort(compareCausal);
  const orderedCausalIds: string[] = [];
  while (ready.length > 0) {
    const causalId = ready.shift()!;
    orderedCausalIds.push(causalId);
    for (const next of outgoing.get(causalId) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        ready.push(next);
        ready.sort(compareCausal);
      }
    }
  }
  if (orderedCausalIds.length !== causalRows.size) {
    return { status: "rebootstrap", scopes: from.map((entry) => entry.scope) };
  }

  const selected = orderedCausalIds
    .slice(0, limit)
    .flatMap((causalId) => causalRows.get(causalId) ?? []);
  const frontier = from.map((entry) => {
    const last = selected
      .filter((row) => row.scopeKind === entry.scope.kind && row.scopeId === entry.scope.id)
      .at(-1);
    return { scope: entry.scope, revision: last?.revision ?? entry.revision };
  });
  const hasMore = frontier.some((entry) => (
    entry.revision < (currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0)
  ));
  return { status: "ok", rows: selected, frontier, hasMore };
}

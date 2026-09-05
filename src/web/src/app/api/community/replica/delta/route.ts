import { NextRequest, NextResponse } from "next/server";
import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  COMMUNITY_REPLICA_MAX_OPERATIONS,
  communityReplicaCategoryValueSchema,
  communityReplicaChannelValueSchema,
  communityReplicaDeltaRequestSchema,
  communityReplicaDeltaResponseSchema,
  communityReplicaMessageValueSchema,
  communityReplicaReadStateValueSchema,
  communityReplicaServerValueSchema,
  communityReplicaUnreadSourceValueSchema,
  isServerOwner,
  queries,
} from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor";
import { parseBody } from "@/lib/middleware/helpers";
import { requireMessageSurfaceAccess, requireServerMember } from "@/lib/community/permissions";
import { enrichMessages } from "@/lib/community/enrich-messages";
import { avatarInitial } from "@/lib/community/avatar";
import { serverIconUrl } from "@/lib/community/storage";

function responseJson(data: unknown) {
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

function projectCanonicalMessage(channelId: string, value: unknown) {
  if (!value || typeof value !== "object") throw new Error("invalid enriched message");
  const {
    mentionType: _mentionType,
    embeds,
    ...message
  } = value as Record<string, unknown>;
  return communityReplicaMessageValueSchema.parse({
    ...message,
    channelId,
    ...(Array.isArray(embeds) ? { embeds } : {}),
  });
}

function remove(kind: "server" | "category" | "channel" | "unread-source" | "read-state", id: string) {
  return { operation: "remove" as const, entity: { kind, id } };
}

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor);
  if (denied) return denied;
  const [input, invalid] = await parseBody(req, communityReplicaDeltaRequestSchema);
  if (invalid) return invalid;
  const db = getPrimaryDb(ctx.env.DB);
  const channelById = new Map<string, { type: string | null }>();
  const permissionChanged = [];

  for (const entry of input.frontier) {
    if (entry.scope.kind === "account") {
      if (entry.scope.id !== ctx.actor.userId) permissionChanged.push(entry.scope);
      continue;
    }
    if (entry.scope.kind === "server") {
      const access = await requireServerMember(db, entry.scope.id, ctx.actor.userId);
      if (!access.ok) permissionChanged.push(entry.scope);
      continue;
    }
    const access = await requireMessageSurfaceAccess(db, entry.scope.id, ctx.actor.userId);
    if (!access.ok || access.value.surface !== "channel") {
      permissionChanged.push(entry.scope);
      continue;
    }
    channelById.set(entry.scope.id, access.value.channel);
  }
  if (permissionChanged.length > 0) {
    return responseJson(communityReplicaDeltaResponseSchema.parse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "rebootstrap",
      reason: "permission-changed",
      scopes: permissionChanged,
    }));
  }

  const window = await queries.communityReplicaDelta.readReplicaDeltaWindow(
    db,
    input.frontier,
    input.limit,
  );
  if (window.status === "rebootstrap") {
    return responseJson(communityReplicaDeltaResponseSchema.parse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "rebootstrap",
      reason: "gap",
      scopes: window.scopes,
    }));
  }

  const messageByScope = new Map<string, Map<string, unknown>>();
  for (const entry of input.frontier) {
    if (entry.scope.kind !== "channel") continue;
    const rows = window.rows.filter((row) => (
      row.scopeKind === "channel"
      && row.scopeId === entry.scope.id
      && row.descriptor.kind === "message-upsert"
    ));
    if (rows.length === 0) continue;
    const ids = rows.flatMap((row) => (
      row.descriptor.kind === "message-upsert" ? [row.descriptor.messageId] : []
    ));
    const raw = await queries.communityMessage.getMessagesByIdsInScope(
      db,
      ids,
      { channelId: entry.scope.id },
    );
    const channel = channelById.get(entry.scope.id);
    const enriched = await enrichMessages(
      db,
      ctx.actor.userId,
      {
        channelId: entry.scope.id,
        isDm: false,
        isForum: channel?.type === "forum",
      },
      raw,
    );
    const projected = enriched.messages.map((message) => projectCanonicalMessage(entry.scope.id, message));
    messageByScope.set(entry.scope.id, new Map(projected.map((message) => [message.id, message])));
    if (projected.length !== new Set(ids).size) {
      return responseJson(communityReplicaDeltaResponseSchema.parse({
        protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
        status: "rebootstrap",
        reason: "gap",
        scopes: [entry.scope],
      }));
    }
  }

  const accountServerIds = new Set<string>();
  const accountReadChannelIds = new Set<string>();
  const categoryIdsByServer = new Map<string, Set<string>>();
  const reconcileCategoryIdsByServer = new Map<string, Set<string>>();
  const channelIdsByServer = new Map<string, Set<string>>();
  const unreadIdsByServer = new Map<string, Set<string>>();
  const addByServer = (target: Map<string, Set<string>>, serverId: string, id: string) => {
    const ids = target.get(serverId) ?? new Set<string>();
    ids.add(id);
    target.set(serverId, ids);
  };
  for (const row of window.rows) {
    switch (row.descriptor.kind) {
      case "server-refresh":
        accountServerIds.add(row.descriptor.serverId);
        break;
      case "read-state-refresh":
        accountReadChannelIds.add(row.descriptor.channelId);
        if (row.descriptor.serverId) accountServerIds.add(row.descriptor.serverId);
        break;
      case "category-refresh":
        addByServer(categoryIdsByServer, row.scopeId, row.descriptor.categoryId);
        if (row.descriptor.reconcileChannels) {
          addByServer(reconcileCategoryIdsByServer, row.scopeId, row.descriptor.categoryId);
        }
        break;
      case "channel-refresh":
        addByServer(channelIdsByServer, row.scopeId, row.descriptor.channelId);
        addByServer(unreadIdsByServer, row.scopeId, row.descriptor.channelId);
        break;
      case "unread-source-refresh":
        addByServer(unreadIdsByServer, row.scopeId, row.descriptor.channelId);
        break;
      default:
        break;
    }
  }

  const [categoryGroups, categoryChannelGroups] = await Promise.all([
    Promise.all([...categoryIdsByServer].map(async ([serverId, ids]) => ({
      serverId,
      rows: await queries.communityReplicaDelta.loadReplicaCategories(db, serverId, [...ids]),
    }))),
    Promise.all([...reconcileCategoryIdsByServer].map(async ([serverId, ids]) => ({
      serverId,
      rows: await queries.communityReplicaDelta.listReplicaCategoryChannelIds(db, serverId, [...ids]),
    }))),
  ]);
  for (const group of categoryChannelGroups) {
    for (const row of group.rows) {
      addByServer(channelIdsByServer, group.serverId, row.channelId);
      addByServer(unreadIdsByServer, group.serverId, row.channelId);
    }
  }

  const [accountServers, readStates, channelGroups, unreadGroups] = await Promise.all([
    queries.communityReplicaDelta.loadReplicaAccountServers(
      db,
      ctx.actor.userId,
      [...accountServerIds],
    ),
    queries.communityReplicaDelta.loadReplicaReadStates(
      db,
      ctx.actor.userId,
      [...accountReadChannelIds],
    ),
    Promise.all([...channelIdsByServer].map(async ([serverId, ids]) => ({
      serverId,
      rows: await queries.communityReplicaDelta.loadReplicaChannels(
        db,
        ctx.actor.userId,
        serverId,
        [...ids],
      ),
    }))),
    Promise.all([...unreadIdsByServer].map(async ([serverId, ids]) => ({
      serverId,
      rows: await queries.communityReplicaDelta.loadReplicaUnreadSources(
        db,
        ctx.actor.userId,
        serverId,
        [...ids],
      ),
    }))),
  ]);
  const serverById = new Map(accountServers.map((server) => [server.id, server]));
  const readStateByChannel = new Map(readStates
    .filter((state) => state.lastReadMessageId)
    .map((state) => [state.channelId, state]));
  const categoryByKey = new Map(categoryGroups.flatMap((group) => group.rows.map((category) => [
    `${group.serverId}:${category.id}`,
    category,
  ] as const)));
  const categoryChannelIdsByKey = new Map<string, string[]>();
  for (const group of categoryChannelGroups) {
    for (const row of group.rows) {
      const key = `${group.serverId}:${row.categoryId}`;
      const ids = categoryChannelIdsByKey.get(key) ?? [];
      ids.push(row.channelId);
      categoryChannelIdsByKey.set(key, ids);
    }
  }
  const channelByKey = new Map(channelGroups.flatMap((group) => group.rows.map((channel) => [
    `${group.serverId}:${channel.id}`,
    channel,
  ] as const)));
  const unreadByKey = new Map<
    string,
    (typeof unreadGroups)[number]["rows"][number]["value"]
  >(unreadGroups.flatMap((group) => group.rows.map((entry) => [
    `${group.serverId}:${entry.channelId}`,
    entry.value,
  ] as const)));

  const projectServer = (serverId: string) => {
    const server = serverById.get(serverId);
    if (!server) return null;
    return communityReplicaServerValueSchema.parse({
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      description: server.description ?? "",
      ownerId: server.ownerId,
      icon: serverIconUrl(server),
      initial: avatarInitial(server.name),
      isOwner: isServerOwner(server.role),
      railOrder: server.railOrder ?? 0,
      unread: server.unreadSources.length > 0,
      mentions: server.mentions,
      unreadSources: server.unreadSources,
      mentionSources: server.mentionSources,
    });
  };
  const appendChannelProjection = (
    operations: unknown[],
    serverId: string,
    channelId: string,
  ) => {
    const channel = channelByKey.get(`${serverId}:${channelId}`);
    if (!channel) {
      operations.push(remove("channel", channelId));
      operations.push(remove("unread-source", channelId));
      return;
    }
    operations.push({
      operation: "upsert",
      entity: { kind: "channel", id: channel.id },
      value: communityReplicaChannelValueSchema.parse({
        ...channel,
        position: channel.position ?? 0,
      }),
    });
    const unread = unreadByKey.get(`${serverId}:${channelId}`);
    operations.push(unread
      ? {
          operation: "upsert",
          entity: { kind: "unread-source", id: unread.channelId },
          value: communityReplicaUnreadSourceValueSchema.parse(unread),
        }
      : remove("unread-source", channelId));
  };

  const batchByCausalId = new Map<string, {
    causalId: string;
    committedAt: string;
    deltas: unknown[];
  }>();
  for (const row of window.rows) {
    const scope = { kind: row.scopeKind, id: row.scopeId };
    const operations: unknown[] = [];
    switch (row.descriptor.kind) {
      case "message-remove":
        operations.push({
          operation: "remove",
          entity: { kind: "message", id: row.descriptor.messageId },
        });
        break;
      case "message-upsert":
        operations.push({
          operation: "upsert",
          entity: { kind: "message", id: row.descriptor.messageId },
          value: messageByScope.get(row.scopeId)?.get(row.descriptor.messageId),
        });
        break;
      case "server-refresh": {
        const value = projectServer(row.descriptor.serverId);
        operations.push(value
          ? { operation: "upsert", entity: { kind: "server", id: value.id }, value }
          : remove("server", row.descriptor.serverId));
        break;
      }
      case "read-state-refresh": {
        const state = readStateByChannel.get(row.descriptor.channelId);
        operations.push(state
          ? {
              operation: "upsert",
              entity: { kind: "read-state", id: state.channelId },
              value: communityReplicaReadStateValueSchema.parse(state),
            }
          : remove("read-state", row.descriptor.channelId));
        if (row.descriptor.serverId) {
          const server = projectServer(row.descriptor.serverId);
          operations.push(server
            ? { operation: "upsert", entity: { kind: "server", id: server.id }, value: server }
            : remove("server", row.descriptor.serverId));
        }
        break;
      }
      case "category-refresh": {
        const category = categoryByKey.get(`${row.scopeId}:${row.descriptor.categoryId}`);
        operations.push(category
          ? {
              operation: "upsert",
              entity: { kind: "category", id: category.id },
              value: communityReplicaCategoryValueSchema.parse({
                ...category,
                position: category.position ?? 0,
                private: category.private === 1,
              }),
            }
          : remove("category", row.descriptor.categoryId));
        if (row.descriptor.reconcileChannels) {
          for (const channelId of categoryChannelIdsByKey.get(
            `${row.scopeId}:${row.descriptor.categoryId}`,
          ) ?? []) {
            appendChannelProjection(operations, row.scopeId, channelId);
          }
        }
        break;
      }
      case "category-remove":
        operations.push(remove("category", row.descriptor.categoryId));
        break;
      case "channel-refresh": {
        appendChannelProjection(operations, row.scopeId, row.descriptor.channelId);
        break;
      }
      case "channel-remove":
        operations.push(remove("channel", row.descriptor.channelId));
        operations.push(remove("unread-source", row.descriptor.channelId));
        break;
      case "unread-source-refresh": {
        const key = `${row.scopeId}:${row.descriptor.channelId}`;
        const unread = unreadByKey.get(key);
        operations.push(unread
          ? {
              operation: "upsert",
              entity: { kind: "unread-source", id: unread.channelId },
              value: communityReplicaUnreadSourceValueSchema.parse(unread),
            }
          : remove("unread-source", row.descriptor.channelId));
        break;
      }
      case "server-metadata-refresh":
      case "server-membership-refresh":
        break;
    }
    if (operations.length > COMMUNITY_REPLICA_MAX_OPERATIONS) {
      return responseJson(communityReplicaDeltaResponseSchema.parse({
        protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
        status: "rebootstrap",
        reason: "gap",
        scopes: [scope],
      }));
    }
    const batch = batchByCausalId.get(row.causalId) ?? {
      causalId: row.causalId,
      committedAt: row.committedAt,
      deltas: [],
    };
    batch.deltas.push({
      scope,
      fromRevision: row.revision - 1,
      toRevision: row.revision,
      operations,
    });
    batchByCausalId.set(row.causalId, batch);
  }
  const response = communityReplicaDeltaResponseSchema.parse({
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    status: "ok",
    from: input.frontier,
    batches: [...batchByCausalId.values()],
    frontier: window.frontier,
    hasMore: window.hasMore,
  });
  return responseJson(response);
});

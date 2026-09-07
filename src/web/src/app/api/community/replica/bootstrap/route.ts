import { NextRequest, NextResponse } from "next/server";
import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaBootstrapRequestSchema,
  communityReplicaBootstrapResponseSchema,
  communityReplicaMessageValueSchema,
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

const PERMISSION_LEASE_MS = 5 * 60 * 1000;

function responseJson(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function permissionLease(epoch: string, checkedAt: string) {
  return {
    epoch,
    checkedAt,
    validUntil: new Date(Date.parse(checkedAt) + PERMISSION_LEASE_MS).toISOString(),
  };
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

class ReplicaPermissionError extends Error {}

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor);
  if (denied) return denied;
  const [input, invalid] = await parseBody(req, communityReplicaBootstrapRequestSchema);
  if (invalid) return invalid;

  const db = getPrimaryDb(ctx.env.DB);
  const accountScope = { kind: "account" as const, id: ctx.actor.userId };
  const serverScope = { kind: "server" as const, id: input.serverId };
  const channelScopes = input.tails.map((tail) => ({
    kind: "channel" as const,
    id: tail.channelId,
  }));
  const scopes = [accountScope, serverScope, ...channelScopes];

  let stable;
  try {
    stable = await queries.communityReplicaBootstrap.readStableReplicaSnapshot(
      db,
      scopes,
      async () => {
        const serverAccess = await requireServerMember(db, input.serverId, ctx.actor.userId);
        if (!serverAccess.ok) throw new ReplicaPermissionError();
        const channelAccess = await Promise.all(input.tails.map(async (tail) => {
          const access = await requireMessageSurfaceAccess(db, tail.channelId, ctx.actor.userId);
          if (
            !access.ok
            || access.value.surface !== "channel"
            || access.value.channel.serverId !== input.serverId
          ) {
            throw new ReplicaPermissionError();
          }
          return access.value.channel;
        }));
        const rows = await queries.communityReplicaBootstrap.loadReplicaBootstrapRows(
          db,
          ctx.actor.userId,
          input.serverId,
          input.tails,
        );
        const messages = await Promise.all(rows.messageTails.map(async (tail, index) => {
          const channel = channelAccess[index]!;
          const enriched = await enrichMessages(
            db,
            ctx.actor.userId,
            {
              channelId: tail.channelId,
              isDm: false,
              isForum: channel.type === "forum",
            },
            tail.rows,
          );
          return {
            ...tail,
            messages: enriched.messages.map((message) => projectCanonicalMessage(tail.channelId, message)),
          };
        }));
        return { ...rows, messages };
      },
    );
  } catch (error) {
    if (error instanceof ReplicaPermissionError) {
      return responseJson({ error: "forbidden" }, 403);
    }
    throw error;
  }

  const takenAt = new Date().toISOString();
  const revisionByScope = new Map(stable.frontier.map((entry) => [
    `${entry.scope.kind}:${entry.scope.id}`,
    entry.revision,
  ]));
  const accountUnreadByServer = new Map<string, Array<{ channelId: string; lastUnreadSeq: number }>>();
  for (const row of stable.value.accountUnread) {
    const sources = accountUnreadByServer.get(row.serverId) ?? [];
    sources.push({ channelId: row.channelId, lastUnreadSeq: row.lastUnreadSeq });
    accountUnreadByServer.set(row.serverId, sources);
  }
  const mentionsByServer = new Map<string, Array<{ channelId: string; count: number; lastSeq: number }>>();
  for (const row of stable.value.mentionSources) {
    if (!row.serverId) continue;
    const sources = mentionsByServer.get(row.serverId) ?? [];
    sources.push({ channelId: row.channelId, count: row.count, lastSeq: row.lastSeq });
    mentionsByServer.set(row.serverId, sources);
  }

  const facts: unknown[] = [];
  for (const server of stable.value.servers) {
    const unreadSources = accountUnreadByServer.get(server.id) ?? [];
    facts.push({
      scope: accountScope,
      entity: { kind: "server", id: server.id },
      value: {
        id: server.id,
        name: server.name,
        discriminator: server.discriminator,
        description: server.description ?? "",
        ownerId: server.ownerId,
        icon: serverIconUrl(server),
        initial: avatarInitial(server.name),
        isOwner: isServerOwner(server.role),
        railOrder: server.railOrder ?? 0,
        joinedAt: server.joinedAt,
        unread: unreadSources.length > 0,
        mentions: server.mentions ?? 0,
        unreadSources,
        mentionSources: mentionsByServer.get(server.id) ?? [],
      },
    });
  }
  for (const category of stable.value.categories) {
    facts.push({
      scope: serverScope,
      entity: { kind: "category", id: category.id },
      value: {
        id: category.id,
        serverId: category.serverId,
        name: category.name,
        position: category.position ?? 0,
        private: category.private === 1,
        creatorId: category.creatorId,
      },
    });
  }
  for (const channel of stable.value.channels) {
    facts.push({
      scope: serverScope,
      entity: { kind: "channel", id: channel.id },
      value: {
        id: channel.id,
        serverId: channel.serverId,
        categoryId: channel.categoryId,
        name: channel.name,
        position: channel.position ?? 0,
        createdAt: channel.createdAt,
        type: channel.type,
        creatorId: channel.creatorId,
      },
    });
  }
  for (const source of stable.value.serverUnread) {
    facts.push({
      scope: serverScope,
      entity: { kind: "unread-source", id: source.channelId },
      value: {
        channelId: source.channelId,
        serverId: source.serverId,
        parentChannelId: source.parentChannelId,
        lastUnreadSeq: source.lastUnreadSeq,
        lastAttentionSeq: source.lastAttentionSeq,
      },
    });
  }
  for (const readState of stable.value.readStates) {
    if (!readState.lastReadMessageId) continue;
    facts.push({
      scope: accountScope,
      entity: { kind: "read-state", id: readState.channelId },
      value: readState,
    });
  }
  for (const tail of stable.value.messages) {
    const scope = { kind: "channel" as const, id: tail.channelId };
    for (const message of tail.messages) {
      facts.push({ scope, entity: { kind: "message", id: message.id }, value: message });
    }
  }

  const coverage = [
    {
      scope: accountScope,
      revision: revisionByScope.get(`account:${accountScope.id}`) ?? 0,
      completeness: "complete" as const,
      permission: permissionLease(`account:${accountScope.id}`, takenAt),
      messageRange: null,
    },
    {
      scope: serverScope,
      revision: revisionByScope.get(`server:${serverScope.id}`) ?? 0,
      completeness: "complete" as const,
      permission: permissionLease(
        `server:${serverScope.id}:${revisionByScope.get(`server:${serverScope.id}`) ?? 0}`,
        takenAt,
      ),
      messageRange: null,
    },
    ...stable.value.messages.map((tail) => {
      const first = tail.messages[0];
      const last = tail.messages.at(-1);
      return {
        scope: { kind: "channel" as const, id: tail.channelId },
        revision: revisionByScope.get(`channel:${tail.channelId}`) ?? 0,
        completeness: tail.hasOlder ? "partial" as const : "complete" as const,
        permission: permissionLease(
          `channel:${tail.channelId}:${revisionByScope.get(`server:${serverScope.id}`) ?? 0}`,
          takenAt,
        ),
        messageRange: first && last ? {
          firstSeq: first.seq,
          lastSeq: last.seq,
          hasOlder: tail.hasOlder,
          hasNewer: false,
        } : null,
      };
    }),
  ];
  const response = communityReplicaBootstrapResponseSchema.parse({
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    snapshotId: crypto.randomUUID(),
    takenAt,
    frontier: stable.frontier,
    coverage,
    facts,
  });
  return responseJson(response);
});

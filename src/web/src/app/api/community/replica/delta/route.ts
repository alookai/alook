import { NextRequest, NextResponse } from "next/server";
import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaDeltaRequestSchema,
  communityReplicaDeltaResponseSchema,
  communityReplicaMessageValueSchema,
  queries,
} from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor";
import { parseBody } from "@/lib/middleware/helpers";
import { requireMessageSurfaceAccess, requireServerMember } from "@/lib/community/permissions";
import { enrichMessages } from "@/lib/community/enrich-messages";

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
    const ids = rows.map((row) => row.descriptor.messageId);
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

  const batchByCausalId = new Map<string, {
    causalId: string;
    committedAt: string;
    deltas: unknown[];
  }>();
  for (const row of window.rows) {
    const scope = { kind: row.scopeKind, id: row.scopeId };
    const operation = row.descriptor.kind === "message-remove"
      ? {
          operation: "remove",
          entity: { kind: "message", id: row.descriptor.messageId },
        }
      : {
          operation: "upsert",
          entity: { kind: "message", id: row.descriptor.messageId },
          value: messageByScope.get(row.scopeId)?.get(row.descriptor.messageId),
        };
    const batch = batchByCausalId.get(row.causalId) ?? {
      causalId: row.causalId,
      committedAt: row.committedAt,
      deltas: [],
    };
    batch.deltas.push({
      scope,
      fromRevision: row.revision - 1,
      toRevision: row.revision,
      operations: [operation],
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

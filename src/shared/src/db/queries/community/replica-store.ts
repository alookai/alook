import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { CommunityReplicaFrontier, CommunityReplicaScope } from "../../../community/replica";
import {
  communityMessage,
  communityReplicaDelta,
  communityReplicaIntent,
  communityReplicaScopeRevision,
} from "../../community-schema";
import type { Database } from "../../index";

const SCOPE_QUERY_CHUNK_SIZE = 40;

export type ReplicaDeltaDescriptor =
  | { kind: "message-upsert"; messageId: string }
  | { kind: "message-remove"; messageId: string }
  | { kind: "server-refresh"; serverId: string }
  | { kind: "read-state-refresh"; channelId: string; serverId?: string }
  | { kind: "server-metadata-refresh"; serverId: string }
  | { kind: "server-membership-refresh"; userId: string }
  | { kind: "category-refresh"; categoryId: string; reconcileChannels: boolean }
  | { kind: "category-remove"; categoryId: string }
  | { kind: "channel-refresh"; channelId: string }
  | { kind: "channel-remove"; channelId: string }
  | { kind: "unread-source-refresh"; channelId: string };

export type ReplicaDeltaRow = {
  scopeKind: string;
  scopeId: string;
  revision: number;
  causalId: string;
  committedAt: string;
  descriptor: ReplicaDeltaDescriptor;
};

export type ReplicaIntentRow = typeof communityReplicaIntent.$inferSelect;

function scopeChunks(scopes: CommunityReplicaScope[]): CommunityReplicaScope[][] {
  const chunks: CommunityReplicaScope[][] = [];
  for (let index = 0; index < scopes.length; index += SCOPE_QUERY_CHUNK_SIZE) {
    chunks.push(scopes.slice(index, index + SCOPE_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

export async function getReplicaScopeRevisions(
  db: Database,
  scopes: CommunityReplicaScope[],
): Promise<CommunityReplicaFrontier> {
  if (scopes.length === 0) return [];
  const rows = (await Promise.all(scopeChunks(scopes).map((chunk) => db
    .select({
      scopeKind: communityReplicaScopeRevision.scopeKind,
      scopeId: communityReplicaScopeRevision.scopeId,
      revision: communityReplicaScopeRevision.revision,
    })
    .from(communityReplicaScopeRevision)
    .where(or(...chunk.map((scope) => and(
      eq(communityReplicaScopeRevision.scopeKind, scope.kind),
      eq(communityReplicaScopeRevision.scopeId, scope.id),
    )))))))
    .flat();
  const revisions = new Map(rows.map((row) => [`${row.scopeKind}:${row.scopeId}`, row.revision]));
  return scopes.map((scope) => ({
    scope,
    revision: revisions.get(`${scope.kind}:${scope.id}`) ?? 0,
  }));
}

export async function listReplicaDeltaRows(
  db: Database,
  scope: CommunityReplicaScope,
  afterRevision: number,
  limit: number,
): Promise<ReplicaDeltaRow[]> {
  const rows = await db
    .select()
    .from(communityReplicaDelta)
    .where(and(
      eq(communityReplicaDelta.scopeKind, scope.kind),
      eq(communityReplicaDelta.scopeId, scope.id),
      gt(communityReplicaDelta.revision, afterRevision),
    ))
    .orderBy(asc(communityReplicaDelta.revision))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    descriptor: parseReplicaDeltaDescriptor(row.descriptor, row.scopeKind),
  }));
}

export function parseReplicaDeltaDescriptor(
  value: string,
  scopeKind?: string,
): ReplicaDeltaDescriptor {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("invalid Replica delta descriptor");
  const descriptor = parsed as Record<string, unknown>;
  const id = (field: string) => typeof descriptor[field] === "string"
    && descriptor[field].length > 0
    ? descriptor[field] as string
    : null;
  let result: ReplicaDeltaDescriptor | null = null;
  switch (descriptor.kind) {
    case "message-upsert":
    case "message-remove": {
      const messageId = id("messageId");
      if (messageId) result = { kind: descriptor.kind, messageId };
      break;
    }
    case "server-refresh": {
      const serverId = id("serverId");
      if (serverId) result = { kind: descriptor.kind, serverId };
      break;
    }
    case "read-state-refresh": {
      const channelId = id("channelId");
      const serverId = id("serverId");
      if (channelId) result = {
        kind: descriptor.kind,
        channelId,
        ...(serverId ? { serverId } : {}),
      };
      break;
    }
    case "server-metadata-refresh": {
      const serverId = id("serverId");
      if (serverId) result = { kind: descriptor.kind, serverId };
      break;
    }
    case "server-membership-refresh": {
      const userId = id("userId");
      if (userId) result = { kind: descriptor.kind, userId };
      break;
    }
    case "category-refresh":
    case "category-remove": {
      const categoryId = id("categoryId");
      if (categoryId) result = descriptor.kind === "category-refresh"
        ? {
            kind: descriptor.kind,
            categoryId,
            reconcileChannels: descriptor.reconcileChannels === true || descriptor.reconcileChannels === 1,
          }
        : { kind: descriptor.kind, categoryId };
      break;
    }
    case "channel-refresh":
    case "channel-remove":
    case "unread-source-refresh": {
      const channelId = id("channelId");
      if (channelId) result = { kind: descriptor.kind, channelId };
      break;
    }
  }
  if (!result) throw new Error("invalid Replica delta descriptor");
  const expectedScope = result.kind.startsWith("message-")
    ? "channel"
    : result.kind === "server-refresh" || result.kind === "read-state-refresh"
      ? "account"
      : "server";
  if (scopeKind && scopeKind !== expectedScope) {
    throw new Error("invalid Replica delta descriptor scope");
  }
  return result;
}

export async function getReplicaIntent(
  db: Database,
  actorId: string,
  intentId: string,
): Promise<ReplicaIntentRow | null> {
  const rows = await db
    .select()
    .from(communityReplicaIntent)
    .where(and(
      eq(communityReplicaIntent.actorId, actorId),
      eq(communityReplicaIntent.intentId, intentId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export function acceptReplicaTextIntentBuilder(
  db: Database,
  input: {
    actorId: string;
    intentId: string;
    requestHash: string;
    channelId: string;
    status: "accepted" | "transformed";
    reason?: string;
    now: string;
  },
) {
  const messageId = sql<string>`(
    SELECT ${communityMessage.id}
    FROM ${communityMessage}
    WHERE ${communityMessage.authorId} = ${input.actorId}
      AND ${communityMessage.clientNonce} = ${input.intentId}
    LIMIT 1
  )`;
  return db.insert(communityReplicaIntent).values({
    actorId: input.actorId,
    intentId: input.intentId,
    requestHash: input.requestHash,
    status: input.status,
    causalId: sql<string>`'message:' || ${messageId}`,
    channelId: input.channelId,
    messageId,
    revision: sql<number>`(
      SELECT ${communityReplicaScopeRevision.revision}
      FROM ${communityReplicaScopeRevision}
      WHERE ${communityReplicaScopeRevision.scopeKind} = 'channel'
        AND ${communityReplicaScopeRevision.scopeId} = ${input.channelId}
      LIMIT 1
    )`,
    seq: sql<number>`(
      SELECT ${communityMessage.seq}
      FROM ${communityMessage}
      WHERE ${communityMessage.authorId} = ${input.actorId}
        AND ${communityMessage.clientNonce} = ${input.intentId}
      LIMIT 1
    )`,
    reason: input.reason ?? null,
    rejectionCode: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function rejectReplicaTextIntent(
  db: Database,
  input: {
    actorId: string;
    intentId: string;
    requestHash: string;
    channelId: string;
    code: "permission-denied" | "target-not-found" | "invalid" | "conflict";
    reason: string;
    now: string;
  },
): Promise<ReplicaIntentRow> {
  await db.insert(communityReplicaIntent).values({
    actorId: input.actorId,
    intentId: input.intentId,
    requestHash: input.requestHash,
    status: "rejected",
    causalId: null,
    channelId: input.channelId,
    messageId: null,
    revision: null,
    seq: null,
    reason: input.reason,
    rejectionCode: input.code,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing({
    target: [communityReplicaIntent.actorId, communityReplicaIntent.intentId],
  });
  const row = await getReplicaIntent(db, input.actorId, input.intentId);
  if (!row) throw new Error("Replica rejected intent was not persisted");
  return row;
}

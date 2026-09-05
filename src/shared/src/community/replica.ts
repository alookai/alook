import { z } from "zod";
import { MAX_MESSAGE_CONTENT_LENGTH } from "../constants/community";
import { FriendApprovalPayloadSchema } from "../community-ws-events";

export const COMMUNITY_REPLICA_PROTOCOL_VERSION = 1 as const;
export const COMMUNITY_REPLICA_MAX_SCOPES = 128;
export const COMMUNITY_REPLICA_MAX_BATCHES = 500;
export const COMMUNITY_REPLICA_MAX_OPERATIONS = 256;
export const COMMUNITY_REPLICA_MAX_INTENTS = 16;

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.string().datetime({ offset: true });
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const communityReplicaScopeSchema = z.strictObject({
  kind: z.enum(["account", "server", "channel"]),
  id: idSchema,
});

export type CommunityReplicaScope = z.infer<typeof communityReplicaScopeSchema>;

export function communityReplicaScopeKey(scope: CommunityReplicaScope): string {
  return `${scope.kind}:${scope.id}`;
}

export const communityReplicaFrontierEntrySchema = z.strictObject({
  scope: communityReplicaScopeSchema,
  revision: revisionSchema,
});

const uniqueFrontierSchema = z
  .array(communityReplicaFrontierEntrySchema)
  .max(COMMUNITY_REPLICA_MAX_SCOPES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const key = communityReplicaScopeKey(entry.scope);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate frontier scope ${key}`,
          path: [index, "scope"],
        });
      }
      seen.add(key);
    }
  });

export const communityReplicaFrontierSchema = uniqueFrontierSchema;
export type CommunityReplicaFrontier = z.infer<typeof communityReplicaFrontierSchema>;

const messageCoverageSchema = z
  .strictObject({
    firstSeq: z.number().int().positive(),
    lastSeq: z.number().int().positive(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
  })
  .superRefine((range, ctx) => {
    if (range.firstSeq > range.lastSeq) {
      ctx.addIssue({ code: "custom", message: "message coverage is reversed" });
    }
  });

const permissionLeaseSchema = z
  .strictObject({
    epoch: idSchema,
    checkedAt: timestampSchema,
    validUntil: timestampSchema,
  })
  .superRefine((lease, ctx) => {
    if (Date.parse(lease.validUntil) <= Date.parse(lease.checkedAt)) {
      ctx.addIssue({ code: "custom", message: "permission lease must expire after it is checked" });
    }
  });

export const communityReplicaCoverageSchema = z.strictObject({
  scope: communityReplicaScopeSchema,
  revision: revisionSchema,
  completeness: z.enum(["complete", "partial"]),
  permission: permissionLeaseSchema,
  messageRange: messageCoverageSchema.nullable(),
});

export type CommunityReplicaCoverage = z.infer<typeof communityReplicaCoverageSchema>;

const communityReplicaEntityKindSchema = z.enum([
  "server",
  "category",
  "channel",
  "unread-source",
  "message",
  "read-state",
]);

const communityReplicaEntitySchema = z.strictObject({
  kind: communityReplicaEntityKindSchema,
  id: idSchema,
});

const unreadSourceSchema = z.strictObject({
  channelId: idSchema,
  lastUnreadSeq: z.number().int().positive(),
});

const mentionSourceSchema = z.strictObject({
  channelId: idSchema,
  count: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
});

export const communityReplicaServerValueSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  discriminator: z.string().regex(/^\d{4}$/),
  description: z.string(),
  ownerId: idSchema,
  icon: z.string().nullable(),
  initial: z.string().min(1),
  isOwner: z.boolean(),
  railOrder: z.number().int().nonnegative(),
  unread: z.boolean(),
  mentions: z.number().int().nonnegative(),
  unreadSources: z.array(unreadSourceSchema),
  mentionSources: z.array(mentionSourceSchema),
});

export const communityReplicaCategoryValueSchema = z.strictObject({
  id: idSchema,
  serverId: idSchema,
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  private: z.boolean(),
  creatorId: idSchema.nullable(),
});

export const communityReplicaChannelValueSchema = z.strictObject({
  id: idSchema,
  serverId: idSchema,
  categoryId: idSchema.nullable(),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  type: z.enum(["text", "forum"]),
  creatorId: idSchema.nullable(),
});

export const communityReplicaUnreadSourceValueSchema = z
  .strictObject({
    channelId: idSchema,
    serverId: idSchema,
    parentChannelId: idSchema.nullable(),
    lastUnreadSeq: z.number().int().positive(),
    lastAttentionSeq: z.number().int().positive().nullable(),
  })
  .superRefine((source, ctx) => {
    if (source.lastAttentionSeq !== null && source.lastAttentionSeq > source.lastUnreadSeq) {
      ctx.addIssue({ code: "custom", message: "attention seq cannot exceed unread seq" });
    }
  });

const embedImageSchema = z.strictObject({
  url: z.string(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
});

const communityReplicaEmbedSchema = z.strictObject({
  provider: z.string().optional(),
  url: z.string().optional(),
  title: z.string(),
  desc: z.string().optional(),
  color: z.string().optional(),
  image: embedImageSchema.optional(),
  thumbnail: z.strictObject({ url: z.string() }).optional(),
  fields: z.array(z.strictObject({
    name: z.string(),
    value: z.string(),
    inline: z.boolean().optional(),
  })).optional(),
  footer: z.strictObject({
    text: z.string(),
    iconUrl: z.string().optional(),
  }).optional(),
  author: z.strictObject({
    name: z.string(),
    url: z.string().optional(),
    iconUrl: z.string().optional(),
  }).optional(),
});

const attachmentMetadataSchema = z.strictObject({
  name: z.string(),
  url: z.string(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const communityReplicaAttachmentSchema = z.union([
  attachmentMetadataSchema.extend({
    kind: z.literal("image"),
    thumbnailUrl: z.string().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  }),
  attachmentMetadataSchema.extend({
    kind: z.literal("file"),
    size: z.string().optional(),
  }),
]);

const communityReplicaReactionSchema = z.strictObject({
  emoji: z.string().min(1),
  count: z.number().int().positive(),
  me: z.boolean(),
  userIds: z.array(idSchema),
});

export const communityReplicaMessageValueSchema = z.strictObject({
  id: idSchema,
  channelId: idSchema,
  type: z.enum(["chat", "system"]),
  systemKind: z.literal("thread").optional(),
  authorId: idSchema,
  authorName: z.string(),
  authorAvatar: z.string(),
  authorAvatarVersion: z.number().int().nonnegative(),
  color: z.string().optional(),
  seq: z.number().int().positive(),
  createdAt: timestampSchema,
  clientNonce: idSchema.optional(),
  content: z.string(),
  embeds: z.array(communityReplicaEmbedSchema).optional(),
  attachments: z.array(communityReplicaAttachmentSchema).optional(),
  reactions: z.array(communityReplicaReactionSchema).optional(),
  replyTo: z.strictObject({
    id: idSchema,
    authorId: idSchema.optional(),
    authorName: z.string(),
    text: z.string(),
    deleted: z.boolean().optional(),
  }).optional(),
  thread: z.strictObject({
    id: idSchema,
    name: z.string(),
    messageCount: z.number().int().nonnegative(),
    lastReplyAt: timestampSchema.optional(),
    tags: z.array(z.string()).optional(),
    preview: z.string().optional(),
    participants: z.array(z.strictObject({
      id: idSchema,
      name: z.string(),
      avatar: z.string(),
      avatarVersion: z.number().int().nonnegative(),
    })).optional(),
    participantCount: z.number().int().nonnegative().optional(),
  }).optional(),
  approval: FriendApprovalPayloadSchema.optional(),
});

export const communityReplicaReadStateValueSchema = z.strictObject({
  channelId: idSchema,
  lastReadMessageId: idSchema,
  lastReadAt: timestampSchema,
  lastReadSeq: z.number().int().positive(),
});

const serverUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("server"), id: idSchema }), value: communityReplicaServerValueSchema });
const categoryUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("category"), id: idSchema }), value: communityReplicaCategoryValueSchema });
const channelUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("channel"), id: idSchema }), value: communityReplicaChannelValueSchema });
const unreadSourceUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("unread-source"), id: idSchema }), value: communityReplicaUnreadSourceValueSchema });
const messageUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("message"), id: idSchema }), value: communityReplicaMessageValueSchema });
const readStateUpsertSchema = z.strictObject({ operation: z.literal("upsert"), entity: z.strictObject({ kind: z.literal("read-state"), id: idSchema }), value: communityReplicaReadStateValueSchema });

const upsertOperationSchemas = [
  serverUpsertSchema,
  categoryUpsertSchema,
  channelUpsertSchema,
  unreadSourceUpsertSchema,
  messageUpsertSchema,
  readStateUpsertSchema,
] as const;

export const communityReplicaOperationSchema = z.union([
  ...upsertOperationSchemas,
  z.strictObject({
    operation: z.literal("remove"),
    entity: communityReplicaEntitySchema,
  }),
]);

type ValidationOperation = {
  operation: "upsert" | "remove";
  entity: { kind: z.infer<typeof communityReplicaEntityKindSchema>; id: string };
  value?: { id?: string; channelId?: string; serverId?: string };
};

function validateOperationIdentity(
  operation: ValidationOperation,
  ctx: z.RefinementCtx,
) {
  if (operation.operation !== "upsert" || !operation.value) return;
  const valueId = "channelId" in operation.value
    && (operation.entity.kind === "unread-source" || operation.entity.kind === "read-state")
    ? operation.value.channelId
    : "id" in operation.value
      ? operation.value.id
      : undefined;
  if (operation.entity.id !== valueId) {
    ctx.addIssue({ code: "custom", message: "entity id does not match value identity" });
  }
}

function validateOperationScope(
  scope: CommunityReplicaScope,
  operation: ValidationOperation,
  ctx: z.RefinementCtx,
) {
  const expectedScope = operation.entity.kind === "server" || operation.entity.kind === "read-state"
    ? "account"
    : operation.entity.kind === "message"
      ? "channel"
      : "server";
  if (scope.kind !== expectedScope) {
    ctx.addIssue({ code: "custom", message: `${operation.entity.kind} is invalid in ${scope.kind} scope` });
    return;
  }
  if (operation.operation === "upsert" && operation.value) {
    if (
      (operation.entity.kind === "category"
        || operation.entity.kind === "channel"
        || operation.entity.kind === "unread-source")
      && "serverId" in operation.value
      && operation.value.serverId !== scope.id
    ) {
      ctx.addIssue({ code: "custom", message: "server-scoped value does not match scope" });
    }
    if (
      operation.entity.kind === "message"
      && operation.value.channelId !== scope.id
    ) {
      ctx.addIssue({ code: "custom", message: "message channel does not match scope" });
    }
  }
}

export type CommunityReplicaOperation = z.infer<typeof communityReplicaOperationSchema>;

export const communityReplicaDeltaSchema = z
  .strictObject({
    scope: communityReplicaScopeSchema,
    fromRevision: revisionSchema,
    toRevision: revisionSchema,
    operations: z.array(communityReplicaOperationSchema).min(1).max(COMMUNITY_REPLICA_MAX_OPERATIONS),
  })
  .superRefine((delta, ctx) => {
    if (delta.toRevision !== delta.fromRevision + 1) {
      ctx.addIssue({ code: "custom", message: "delta must advance exactly one revision" });
    }
    for (const operation of delta.operations) {
      validateOperationIdentity(operation, ctx);
      validateOperationScope(delta.scope, operation, ctx);
    }
  });

export type CommunityReplicaDelta = z.infer<typeof communityReplicaDeltaSchema>;

export const communityReplicaCausalBatchSchema = z
  .strictObject({
    causalId: idSchema,
    committedAt: timestampSchema,
    deltas: z.array(communityReplicaDeltaSchema).min(1).max(COMMUNITY_REPLICA_MAX_SCOPES),
  })
  .superRefine((batch, ctx) => {
    const seen = new Set<string>();
    for (const [index, delta] of batch.deltas.entries()) {
      const key = communityReplicaScopeKey(delta.scope);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `causal batch advances ${key} more than once`,
          path: ["deltas", index, "scope"],
        });
      }
      seen.add(key);
    }
  });

export type CommunityReplicaCausalBatch = z.infer<typeof communityReplicaCausalBatchSchema>;

export const communityReplicaBootstrapRequestSchema = z.strictObject({
  protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
  serverId: idSchema,
  tails: z
    .array(z.strictObject({
      channelId: idSchema,
      limit: z.number().int().min(1).max(100),
    }))
    .max(32)
    .superRefine((tails, ctx) => {
      const seen = new Set<string>();
      for (const [index, tail] of tails.entries()) {
        if (seen.has(tail.channelId)) {
          ctx.addIssue({ code: "custom", message: "duplicate tail channel", path: [index, "channelId"] });
        }
        seen.add(tail.channelId);
      }
    }),
});

export const communityReplicaFactSchema = z.union([
  serverUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
  categoryUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
  channelUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
  unreadSourceUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
  messageUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
  readStateUpsertSchema.omit({ operation: true }).extend({ scope: communityReplicaScopeSchema }),
]);

export const communityReplicaBootstrapResponseSchema = z
  .strictObject({
    protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
    snapshotId: idSchema,
    takenAt: timestampSchema,
    frontier: uniqueFrontierSchema,
    coverage: z.array(communityReplicaCoverageSchema).max(COMMUNITY_REPLICA_MAX_SCOPES),
    facts: z.array(communityReplicaFactSchema),
  })
  .superRefine((snapshot, ctx) => {
    const frontier = new Map(snapshot.frontier.map((entry) => [
      communityReplicaScopeKey(entry.scope),
      entry.revision,
    ]));
    const coverage = new Set<string>();
    for (const [index, item] of snapshot.coverage.entries()) {
      const key = communityReplicaScopeKey(item.scope);
      if (coverage.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate coverage scope ${key}`, path: ["coverage", index] });
      }
      coverage.add(key);
      if (frontier.get(key) !== item.revision) {
        ctx.addIssue({ code: "custom", message: `coverage/frontier mismatch for ${key}`, path: ["coverage", index] });
      }
    }
    for (const [index, fact] of snapshot.facts.entries()) {
      const key = communityReplicaScopeKey(fact.scope);
      if (!coverage.has(key)) {
        ctx.addIssue({ code: "custom", message: `fact outside coverage ${key}`, path: ["facts", index] });
      }
      validateOperationIdentity({ operation: "upsert", entity: fact.entity, value: fact.value }, ctx);
      validateOperationScope(fact.scope, { operation: "upsert", entity: fact.entity, value: fact.value }, ctx);
    }
  });

export type CommunityReplicaBootstrapRequest = z.infer<typeof communityReplicaBootstrapRequestSchema>;
export type CommunityReplicaBootstrapResponse = z.infer<typeof communityReplicaBootstrapResponseSchema>;

export const communityReplicaDeltaRequestSchema = z.strictObject({
  protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
  frontier: uniqueFrontierSchema.min(1),
  limit: z.number().int().min(1).max(COMMUNITY_REPLICA_MAX_BATCHES),
});

const communityReplicaDeltaOkSchema = z
  .strictObject({
    protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
    status: z.literal("ok"),
    from: uniqueFrontierSchema.min(1),
    batches: z.array(communityReplicaCausalBatchSchema).max(COMMUNITY_REPLICA_MAX_BATCHES),
    frontier: uniqueFrontierSchema.min(1),
    hasMore: z.boolean(),
  })
  .superRefine((response, ctx) => {
    const current = new Map(response.from.map((entry) => [
      communityReplicaScopeKey(entry.scope),
      entry.revision,
    ]));
    for (const [batchIndex, batch] of response.batches.entries()) {
      for (const [deltaIndex, delta] of batch.deltas.entries()) {
        const key = communityReplicaScopeKey(delta.scope);
        const expected = current.get(key);
        if (expected === undefined || delta.fromRevision !== expected) {
          ctx.addIssue({
            code: "custom",
            message: `non-contiguous delta for ${key}`,
            path: ["batches", batchIndex, "deltas", deltaIndex],
          });
          continue;
        }
        current.set(key, delta.toRevision);
      }
    }
    const reported = new Map(response.frontier.map((entry) => [
      communityReplicaScopeKey(entry.scope),
      entry.revision,
    ]));
    if (
      current.size !== reported.size
      || [...current].some(([key, revision]) => reported.get(key) !== revision)
    ) {
      ctx.addIssue({ code: "custom", message: "reported frontier does not match applied batches", path: ["frontier"] });
    }
  });

const communityReplicaRebootstrapSchema = z.strictObject({
  protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
  status: z.literal("rebootstrap"),
  reason: z.enum(["gap", "compacted", "permission-changed", "schema-changed"]),
  scopes: z.array(communityReplicaScopeSchema).min(1).max(COMMUNITY_REPLICA_MAX_SCOPES),
});

export const communityReplicaDeltaResponseSchema = z.discriminatedUnion("status", [
  communityReplicaDeltaOkSchema,
  communityReplicaRebootstrapSchema,
]);

export type CommunityReplicaDeltaRequest = z.infer<typeof communityReplicaDeltaRequestSchema>;
export type CommunityReplicaDeltaResponse = z.infer<typeof communityReplicaDeltaResponseSchema>;

const channelScopeSchema = communityReplicaScopeSchema.refine(
  (scope) => scope.kind === "channel",
  { message: "message intent requires a channel scope" },
);

export const communityReplicaTextSendIntentSchema = z.strictObject({
  intentId: idSchema,
  kind: z.literal("message.send"),
  scope: channelScopeSchema,
  createdAt: timestampSchema,
  payload: z.strictObject({
    content: z.string().min(1).max(MAX_MESSAGE_CONTENT_LENGTH),
    replyToId: idSchema.optional(),
    mentionType: z.literal("everyone").optional(),
  }),
});

export type CommunityReplicaTextSendIntent = z.infer<typeof communityReplicaTextSendIntentSchema>;

const canonicalMessageOutcomeSchema = z.strictObject({
  scope: channelScopeSchema,
  revision: revisionSchema,
  messageId: idSchema,
  seq: z.number().int().positive(),
});

export const communityReplicaIntentOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    intentId: idSchema,
    status: z.literal("accepted"),
    causalId: idSchema,
    canonical: canonicalMessageOutcomeSchema,
  }),
  z.strictObject({
    intentId: idSchema,
    status: z.literal("transformed"),
    causalId: idSchema,
    canonical: canonicalMessageOutcomeSchema,
    reason: z.string().min(1).max(256),
  }),
  z.strictObject({
    intentId: idSchema,
    status: z.literal("rejected"),
    code: z.enum(["permission-denied", "target-not-found", "invalid", "conflict"]),
    reason: z.string().min(1).max(256),
  }),
]);

export type CommunityReplicaIntentOutcome = z.infer<typeof communityReplicaIntentOutcomeSchema>;

export const communityReplicaIntentRequestSchema = z.strictObject({
  protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
  intents: z.array(communityReplicaTextSendIntentSchema).min(1).max(COMMUNITY_REPLICA_MAX_INTENTS),
}).superRefine((request, ctx) => {
  const seen = new Set<string>();
  for (const [index, intent] of request.intents.entries()) {
    if (seen.has(intent.intentId)) {
      ctx.addIssue({ code: "custom", message: "duplicate intentId", path: ["intents", index, "intentId"] });
    }
    seen.add(intent.intentId);
  }
});

export const communityReplicaIntentResponseSchema = z.strictObject({
  protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
  outcomes: z.array(communityReplicaIntentOutcomeSchema).min(1).max(COMMUNITY_REPLICA_MAX_INTENTS),
}).superRefine((response, ctx) => {
  const seen = new Set<string>();
  for (const [index, outcome] of response.outcomes.entries()) {
    if (seen.has(outcome.intentId)) {
      ctx.addIssue({ code: "custom", message: "duplicate intent outcome", path: ["outcomes", index, "intentId"] });
    }
    seen.add(outcome.intentId);
  }
});

export type CommunityReplicaIntentRequest = z.infer<typeof communityReplicaIntentRequestSchema>;
export type CommunityReplicaIntentResponse = z.infer<typeof communityReplicaIntentResponseSchema>;

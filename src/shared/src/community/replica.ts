import { z } from "zod";
import { MAX_MESSAGE_CONTENT_LENGTH } from "../constants/community";

export const COMMUNITY_REPLICA_PROTOCOL_VERSION = 1 as const;
export const COMMUNITY_REPLICA_MAX_SCOPES = 128;
export const COMMUNITY_REPLICA_MAX_BATCHES = 500;
export const COMMUNITY_REPLICA_MAX_OPERATIONS = 256;
export const COMMUNITY_REPLICA_MAX_INTENTS = 16;

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.string().datetime({ offset: true });
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

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

const communityReplicaEntitySchema = z.strictObject({
  kind: z.enum(["server", "channel", "message", "read-state"]),
  id: idSchema,
});

export const communityReplicaOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("upsert"),
    entity: communityReplicaEntitySchema,
    value: z.record(z.string(), jsonValueSchema),
  }),
  z.strictObject({
    operation: z.literal("remove"),
    entity: communityReplicaEntitySchema,
  }),
]);

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

export const communityReplicaBootstrapResponseSchema = z
  .strictObject({
    protocolVersion: z.literal(COMMUNITY_REPLICA_PROTOCOL_VERSION),
    snapshotId: idSchema,
    takenAt: timestampSchema,
    frontier: uniqueFrontierSchema,
    coverage: z.array(communityReplicaCoverageSchema).max(COMMUNITY_REPLICA_MAX_SCOPES),
    facts: z.array(z.strictObject({
      scope: communityReplicaScopeSchema,
      entity: communityReplicaEntitySchema,
      value: z.record(z.string(), jsonValueSchema),
    })),
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
    mentionType: z.string().trim().min(1).max(64).optional(),
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

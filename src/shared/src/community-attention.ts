import { z } from "zod"

const id = z.string().min(1)

export const AttentionScopeSchema = z.strictObject({
  scopeId: id,
  channelId: id,
  serverId: id.nullable().optional(),
  parentChannelId: id.nullable().optional(),
  ordinaryUnread: z.boolean(),
  lastUnreadSeq: z.number().int().nonnegative(),
  lastAttentionSeq: z.number().int().nonnegative().nullable().optional(),
  attentionCount: z.number().int().nonnegative(),
})

export const AttentionItemSchema = z.strictObject({
  id,
  kind: z.enum(["mention", "reply", "friend_request"]),
  sourceId: id,
  scopeId: id.nullable().optional(),
  messageId: id.nullable().optional(),
  actorUserId: id,
  createdAt: z.string(),
}).superRefine((item, ctx) => {
  if (item.kind === "friend_request") {
    if (item.scopeId != null || item.messageId != null) {
      ctx.addIssue({ code: "custom", message: "friend request cannot reference a scope or message" })
    }
    return
  }
  if (!item.scopeId || !item.messageId) {
    ctx.addIssue({ code: "custom", message: "message attention requires scope and message refs" })
  }
})

export const AttentionIncludedSchema = z.strictObject({
  profiles: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
})

export const AccountAttentionSnapshotSchema = z.strictObject({
  scopes: z.array(AttentionScopeSchema),
  items: z.array(AttentionItemSchema),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
  included: AttentionIncludedSchema.optional(),
}).superRefine((snapshot, ctx) => {
  const scopeIds = new Set<string>()
  for (const scope of snapshot.scopes) {
    if (scopeIds.has(scope.scopeId)) {
      ctx.addIssue({ code: "custom", message: `duplicate attention scope: ${scope.scopeId}` })
    }
    scopeIds.add(scope.scopeId)
  }
  const itemIds = new Set<string>()
  for (const item of snapshot.items) {
    if (itemIds.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate attention item: ${item.id}` })
    }
    itemIds.add(item.id)
    if (item.scopeId && !scopeIds.has(item.scopeId)) {
      ctx.addIssue({ code: "custom", message: `attention item references missing scope: ${item.scopeId}` })
    }
  }
})

export type AttentionScope = z.infer<typeof AttentionScopeSchema>
export type AttentionItem = z.infer<typeof AttentionItemSchema>
export type AccountAttentionSnapshot = z.infer<typeof AccountAttentionSnapshotSchema>

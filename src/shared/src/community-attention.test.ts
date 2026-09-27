import { describe, expect, it } from "vitest"
import {
  AccountAttentionSnapshotSchema,
  AttentionItemSchema,
} from "./community-attention"

const scope = {
  scopeId: "c1",
  channelId: "c1",
  serverId: "s1",
  parentChannelId: null,
  ordinaryUnread: true,
  lastUnreadSeq: 7,
  lastAttentionSeq: 7,
  attentionCount: 1,
}

const item = {
  id: "mention:a1",
  kind: "mention" as const,
  sourceId: "a1",
  scopeId: "c1",
  messageId: "m7",
  actorUserId: "u2",
  createdAt: "2026-09-27T00:00:00.000Z",
}

describe("account attention wire schemas", () => {
  it("rejects invalid attention-item reference shapes", () => {
    expect(AttentionItemSchema.safeParse({
      ...item,
      kind: "friend_request",
    }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({
      ...item,
      scopeId: null,
      messageId: null,
    }).success).toBe(false)
  })

  it("accepts ref-only snapshots and the existing reply kind", () => {
    expect(AccountAttentionSnapshotSchema.parse({
      scopes: [scope],
      items: [item, { ...item, id: "mention:a2", sourceId: "a2", kind: "reply" }],
      limit: 100,
      truncated: false,
    }).items).toHaveLength(2)
  })

  it("rejects display identity and message content inside fact rows", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [{ ...scope, channelName: "general" }],
      items: [{ ...item, actorName: "Alice", content: "hello" }],
      limit: 100,
      truncated: false,
    }).success).toBe(false)
  })

  it("rejects duplicate ids and dangling scope references", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [scope, scope],
      items: [item, item],
      limit: 100,
      truncated: false,
    }).success).toBe(false)
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [],
      items: [item],
      limit: 100,
      truncated: false,
    }).success).toBe(false)
  })
})

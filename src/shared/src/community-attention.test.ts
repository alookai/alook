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

const included = {
  servers: [{ id: "s1", name: "One", discriminator: "0001" }],
  channels: [{
    id: "c1",
    serverId: "s1",
    name: "general",
    type: "text" as const,
    parentChannelId: null,
    parentMessageId: null,
    creatorId: "u1",
    archived: false,
    lastMessageAt: "2026-09-27T00:00:00.000Z",
  }],
  dms: [],
  profiles: [{
    userId: "u2",
    name: "Alice",
    discriminator: "0002",
    avatar: "",
    avatarVersion: 1,
  }],
  messages: [{
    id: "m7",
    channelId: "c1",
    type: "chat" as const,
    authorId: "u2",
    authorName: "Alice",
    seq: 7,
    createdAt: "2026-09-27T00:00:00.000Z",
    content: "hello",
  }],
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

  it("accepts self-contained snapshots and the existing reply kind", () => {
    expect(AccountAttentionSnapshotSchema.parse({
      scopes: [scope],
      items: [item, { ...item, id: "mention:a2", sourceId: "a2", kind: "reply" }],
      limit: 100,
      truncated: false,
      included,
    }).items).toHaveLength(2)
  })

  it("rejects display identity and message content inside fact rows", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [{ ...scope, channelName: "general" }],
      items: [{ ...item, actorName: "Alice", content: "hello" }],
      limit: 100,
      truncated: false,
      included,
    }).success).toBe(false)
  })

  it("rejects duplicate ids and dangling scope references", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [scope, scope],
      items: [item, item],
      limit: 100,
      truncated: false,
      included,
    }).success).toBe(false)
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [],
      items: [item],
      limit: 100,
      truncated: false,
      included,
    }).success).toBe(false)
  })

  it("rejects a scope whose canonical owner graph is incomplete", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [scope],
      items: [item],
      limit: 100,
      truncated: false,
      included: { ...included, servers: [] },
    }).success).toBe(false)
  })

  it("requires exact forum-post parent, child, opener, and read-target refs", () => {
    const forumScope = { ...scope, scopeId: "forum", channelId: "forum" }
    const forumIncluded = {
      ...included,
      channels: [{
        ...included.channels[0],
        id: "forum",
        name: "ideas",
        type: "forum" as const,
      }, {
        ...included.channels[0],
        id: "post",
        name: "Launch",
        type: "thread" as const,
        parentChannelId: "forum",
        parentMessageId: "opener",
      }],
      messages: [{
        id: "opener",
        channelId: "forum",
        type: "chat" as const,
        seq: 7,
        createdAt: "2026-09-27T00:00:00.000Z",
        content: "Launch",
      }],
    }
    const forumPost = {
      id: "forum_post:post",
      kind: "forum_post" as const,
      sourceId: "post",
      scopeId: "forum",
      messageId: "opener",
      actorUserId: null,
      childChannelId: "post",
      openerSeq: 7,
      readTarget: { channelId: "forum", seq: 7 },
      createdAt: "2026-09-27T00:00:00.000Z",
    }

    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [forumScope],
      items: [forumPost],
      limit: 100,
      truncated: false,
      included: forumIncluded,
    }).success).toBe(true)
    expect(AccountAttentionSnapshotSchema.safeParse({
      scopes: [forumScope],
      items: [{ ...forumPost, readTarget: { channelId: "forum", seq: 6 } }],
      limit: 100,
      truncated: false,
      included: forumIncluded,
    }).success).toBe(false)
  })
})

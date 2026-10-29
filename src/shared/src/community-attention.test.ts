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

const fullChannel = { id: "c1", type: "text" as const, serverId: "s1", categoryId: null, name: "general", topic: "", parentChannelId: null, parentMessageId: null, creatorId: "u1", position: 0, archived: false, createdAt: "2026-09-27T00:00:00.000Z", lastMessageAt: null, messageCount: 0 }
const fullMessage = { id: "m7", channelId: "c1", seq: 7, authorId: "u2", type: "chat" as const, createdAt: "2026-09-27T00:00:00.000Z", content: "hello", replyToId: null, clientNonce: null, attachments: [] }
const currentChannels = [
  { ...fullChannel, id: "c1", serverId: "s1", name: "general" },
  { ...fullChannel, id: "forum", serverId: "s1", name: "Ideas", type: "forum" as const },
  { ...fullChannel, id: "post", serverId: "s1", name: "Launch", type: "thread" as const, parentChannelId: "forum", parentMessageId: "opener" },
  { ...fullChannel, id: "dm", serverId: null, name: null, type: "dm" as const },
]
const currentResources = {
  viewerId: "u1", servers: [{ id: "s1", name: "One", discriminator: "0001", description: "", ownerId: "u1", position: 0, icon: null, official: false, isOwner: true }],
  serverMemberships: [{ serverId: "s1", userId: "u1", memberId: "member-u1", role: "owner" }],
  channels: currentChannels, memberships: currentChannels.map(channel => ({ channelId: channel.id, userId: "u1", relation: "access" as const, source: "explicit" as const })),
  profiles: [{ id: "u2", name: "Alice", discriminator: "0002", avatar: "", avatarVersion: 1 }, { id: "peer", name: "Peer", discriminator: "0002", avatar: "P", avatarVersion: 1 }],
  messages: [{ ...fullMessage, id: "m7", channelId: "c1", authorId: "u2", seq: 7, content: "hello" }, { ...fullMessage, id: "opener", channelId: "forum", authorId: "u2", seq: 7, content: "Launch" }],
}

function childThreadSnapshot() {
  return {
    scopes: [{
      ...scope,
      scopeId: "post",
      channelId: "post",
      parentChannelId: "forum",
    }],
    items: [],
    limit: 100,
    truncated: false,
    included: {
      servers: included.servers,
      channels: [{
        ...included.channels[0],
        id: "forum",
        name: "Ideas",
        type: "forum" as const,
      }, {
        ...included.channels[0],
        id: "post",
        name: "Launch",
        type: "thread" as const,
        parentChannelId: "forum",
        parentMessageId: "opener",
        openerSeq: 7,
        openerUnread: false,
      }],
      dms: [],
      profiles: [],
      messages: [{
        id: "opener",
        channelId: "forum",
        type: "chat" as const,
        seq: 7,
        createdAt: "2026-09-27T00:00:00.000Z",
        content: "Launch",
      }],
    },
  }
}

function dmSnapshot() {
  return {
    scopes: [{
      ...scope,
      scopeId: "dm",
      channelId: "dm",
      serverId: null,
      parentChannelId: null,
      attentionCount: 0,
      lastAttentionSeq: null,
    }],
    items: [],
    limit: 100,
    truncated: false,
    included: {
      servers: [],
      channels: [],
      dms: [{
        id: "dm",
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 1,
        lastMessageAt: "2026-09-27T00:00:00.000Z",
        lastUnreadSeq: 7,
      }],
      profiles: [{
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 1,
      }],
      messages: [],
    },
  }
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
    expect(AttentionItemSchema.safeParse({
      id: "friend_request:f1",
      kind: "friend_request",
      sourceId: "f1",
      scopeId: null,
      messageId: null,
      actorUserId: "u2",
      childChannelId: "post",
      createdAt: item.createdAt,
    }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({ ...item, actorUserId: null }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({
      ...item,
      childChannelId: "post",
    }).success).toBe(false)
  })

  it("accepts self-contained snapshots and the existing reply kind", () => {
    expect(AccountAttentionSnapshotSchema.parse({ resources: currentResources, ...({
      scopes: [scope],
      items: [item, { ...item, id: "mention:a2", sourceId: "a2", kind: "reply" }],
      limit: 100,
      truncated: false,
      included,
    }) }).items).toHaveLength(2)
  })

  it("rejects display identity and message content inside fact rows", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [{ ...scope, channelName: "general" }],
      items: [{ ...item, actorName: "Alice", content: "hello" }],
      limit: 100,
      truncated: false,
      included,
    }) }).success).toBe(false)
  })

  it("rejects duplicate ids and dangling scope references", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [scope, scope],
      items: [item, item],
      limit: 100,
      truncated: false,
      included,
    }) }).success).toBe(false)
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [],
      items: [item],
      limit: 100,
      truncated: false,
      included,
    }) }).success).toBe(false)
  })

  it("rejects a scope whose canonical owner graph is incomplete", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [scope],
      items: [item],
      limit: 100,
      truncated: false,
      included: { ...included, servers: [] },
    }) }).success).toBe(false)
  })

  it("validates every child-thread parent and opener edge", () => {
    const valid = childThreadSnapshot()
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(valid) }).success).toBe(true)

    const broken = [
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        candidate.included.channels[1]!.parentChannelId = null
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        candidate.included.channels.splice(0, 1)
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        candidate.included.channels[0]!.serverId = "other-server"
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        candidate.included.channels[1]!.parentMessageId = null
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        candidate.included.messages[0]!.channelId = "post"
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        Object.assign(candidate.included.channels[1]!, { openerSeq: 6 })
      },
      (candidate: ReturnType<typeof childThreadSnapshot>) => {
        Reflect.deleteProperty(candidate.included.channels[1]!, "openerUnread")
      },
    ]
    for (const mutate of broken) {
      const candidate = structuredClone(valid)
      mutate(candidate)
      expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(candidate) }).success).toBe(false)
    }

    const topLevelMismatch = childThreadSnapshot()
    Object.assign(topLevelMismatch.scopes[0]!, { parentChannelId: null })
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(topLevelMismatch) }).success).toBe(false)
  })

  it("requires a DM scope to carry both its DM and profile owners", () => {
    const valid = dmSnapshot()
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(valid) }).success).toBe(true)

    const missingDm = dmSnapshot()
    missingDm.included.dms = []
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(missingDm) }).success).toBe(false)

    const missingProfile = dmSnapshot()
    missingProfile.included.profiles = []
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...(missingProfile) }).success).toBe(false)
  })

  it("rejects friend and message items without their canonical owners", () => {
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [],
      items: [{
        id: "friend_request:f1",
        kind: "friend_request",
        sourceId: "f1",
        scopeId: null,
        messageId: null,
        actorUserId: "missing",
        createdAt: item.createdAt,
      }],
      limit: 100,
      truncated: false,
      included: { ...included, profiles: [] },
    }) }).success).toBe(false)

    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [scope],
      items: [{ ...item, scopeId: null }],
      limit: 100,
      truncated: false,
      included,
    }) }).success).toBe(false)

    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [scope],
      items: [item],
      limit: 100,
      truncated: false,
      included: {
        ...included,
        messages: [{ ...included.messages[0], channelId: "other" }],
      },
    }) }).success).toBe(false)
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

    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [forumScope],
      items: [forumPost],
      limit: 100,
      truncated: false,
      included: forumIncluded,
    }) }).success).toBe(true)
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [forumScope],
      items: [{ ...forumPost, readTarget: { channelId: "forum", seq: 6 } }],
      limit: 100,
      truncated: false,
      included: forumIncluded,
    }) }).success).toBe(false)
    expect(AccountAttentionSnapshotSchema.safeParse({ resources: currentResources, ...({
      scopes: [forumScope],
      items: [{ ...forumPost, readTarget: { channelId: "wrong", seq: 7 } }],
      limit: 100,
      truncated: false,
      included: forumIncluded,
    }) }).success).toBe(false)
  })
})

it("requires a resource bundle on the HTTP snapshot even for an empty projection", () => {
  expect(AccountAttentionSnapshotSchema.safeParse({ scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }).success).toBe(false)
})

import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommunityWsEvent } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { getLastChannel, setLastChannel } from "@/lib/community/last-channel"
import {
  getLastMeLeaf,
  setLastMeLocation,
} from "@/lib/community/last-me-location"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "./collections"
import {
  ingestDms,
  ingestMessages,
  ingestReadStateSnapshot,
  ingestServerDetail,
  ingestServers,
  installCommunityDbSync,
  projectCommunityWsEventToDb,
  purgeCommunityChannel,
  purgeCommunityServer,
} from "./sync"

const registries: CommunityDbRegistry[] = []
const unregisters: Array<() => void> = []

async function registry() {
  const result = createCommunityDbRegistry(new QueryClient(), "viewer")
  registries.push(result)
  await result.preload()
  unregisters.push(registerCommunityDbRegistry(result))
  return result
}

afterEach(async () => {
  unregisters.splice(0).forEach((unregister) => unregister())
  await Promise.all(registries.splice(0).map((entry) => entry.cleanup()))
  vi.unstubAllGlobals()
})

describe("community DB sync", () => {
  it("normalizes server, tree, and DM relationships into canonical identities", async () => {
    const db = await registry()
    ingestServers(db, {
      servers: [{
        id: "s1",
        name: "Alook",
        discriminator: "0001",
        description: "",
        ownerId: "viewer",
        initial: "A",
        active: false,
        unread: false,
        mentions: 0,
        isOwner: true,
      }],
    })
    ingestServerDetail(db, {
      id: "s1",
      name: "Alook",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "General",
        channels: [{
          id: "c1",
          name: "chat",
          active: false,
          unread: false,
          type: "text",
        }],
      }],
    })
    ingestDms(db, {
      conversations: [{
        id: "dm1",
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 1,
        status: "offline",
        preview: "hello",
        unread: true,
        lastUnreadSeq: 7,
      }],
    })

    expect(db.collections.servers.get("s1")).toMatchObject({ ownerId: "viewer" })
    expect(db.collections.serverMemberships.get("s1:viewer")).toMatchObject({ viewer: true })
    expect(db.collections.categories.get("cat1")).toMatchObject({ serverId: "s1" })
    expect(db.collections.channels.get("c1")).toMatchObject({ serverId: "s1", categoryId: "cat1" })
    expect(db.collections.channelMemberships.get("c1:viewer:access")).toMatchObject({
      relation: "access",
      source: "inherited",
    })
    expect(db.collections.channels.get("dm1")).toMatchObject({ type: "dm", serverId: null })
    expect(db.collections.channelMemberships.get("dm1:viewer:access")).toBeDefined()
    expect(db.collections.channelMemberships.get("dm1:peer:access")).toBeDefined()
    expect(db.collections.profiles.get("peer")).toMatchObject({ name: "Peer" })
  })

  it("keeps read-state replacement monotonic", async () => {
    const db = await registry()
    ingestReadStateSnapshot(db, {
      revision: 4,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m4",
        lastReadAt: "2026-09-25T00:00:00.000Z",
        lastReadSeq: 4,
      }],
    })
    ingestReadStateSnapshot(db, {
      revision: 3,
      readStates: [],
    })
    ingestReadStateSnapshot(db, {
      revision: 4,
      readStates: [],
    })
    expect(db.collections.readStateClock.get("account")?.revision).toBe(4)
    expect(db.collections.readStates.get("c1")?.lastReadSeq).toBe(4)
    ingestReadStateSnapshot(db, {
      revision: 5,
      readStates: [],
    })
    expect(db.collections.readStateClock.get("account")?.revision).toBe(5)
    expect(db.collections.readStates.get("c1")).toBeUndefined()
  })

  it("cascades roots removed by authoritative server, tree, and DM replacement", async () => {
    const db = await registry()
    const navigationMemory = new Map<string, string>()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => navigationMemory.get(key) ?? null,
      setItem: (key: string, value: string) => navigationMemory.set(key, value),
      removeItem: (key: string) => navigationMemory.delete(key),
    })
    const unreadProjection = getAccountUnreadProjection(db.queryClient, "viewer")
    ingestServers(db, {
      servers: [{
        id: "s1", name: "Server", initial: "S", active: false, unread: false,
        mentions: 0, ownerId: "viewer",
      }],
    })
    ingestServerDetail(db, {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "General",
        channels: [{ id: "c1", name: "chat", active: false, unread: false }],
      }],
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.child_create",
      parentChannelId: "c1",
      parentMessageId: "opener",
      channel: {
        id: "thread1", name: "Thread", type: "thread",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    } as CommunityWsEvent)
    ingestMessages(db, "thread1", [{
      id: "m1", type: "chat", authorId: "thread-author", authorName: "Thread Author",
      content: "thread", createdAt: "2026-09-25T00:00:01.000Z",
    }])
    unreadProjection.recordArrival({ channelId: "c1", serverId: "s1", seq: 1 })
    db.queryClient.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [],
      servers: [{
        serverId: "s1",
        serverName: "Server",
        channels: [{
          channelId: "c1",
          channelName: "chat",
          lastMessageAt: "2026-09-25T00:00:00.000Z",
          mentionCount: 0,
          children: [{
            channelId: "thread1",
            channelName: "Thread",
            lastMessageAt: "2026-09-25T00:00:01.000Z",
            mentionCount: 0,
          }],
        }],
      }],
      dms: [],
    })
    setLastChannel("s1", "c1")
    ingestServerDetail(db, {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [],
    })
    expect(db.collections.channels.get("c1")).toBeUndefined()
    expect(db.collections.channels.get("thread1")).toBeUndefined()
    expect(db.collections.messages.get("m1")).toBeUndefined()
    expect(db.collections.channelMemberships.get("c1:viewer:access")).toBeUndefined()
    expect(db.collections.profiles.get("thread-author")).toBeUndefined()
    expect(unreadProjection.projectUnread("inbox-unreads", "c1", true)).toBe(false)
    expect(db.queryClient.getQueryData<{ servers: unknown[] }>(
      communityKeys.inboxUnreads(),
    )?.servers).toEqual([])
    expect(getLastChannel("s1")).toBeNull()

    ingestDms(db, {
      conversations: [{
        id: "dm1", userId: "peer", name: "Peer", discriminator: "0002",
        avatar: "P", avatarVersion: 1, status: "offline", preview: "",
      }],
    })
    ingestMessages(db, "dm1", [{
      id: "dm-message", type: "chat", authorId: "peer", authorName: "Peer",
      content: "dm", createdAt: "2026-09-25T00:00:02.000Z",
    }])
    unreadProjection.recordArrival({ channelId: "dm1", seq: 2 })
    db.queryClient.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [],
      servers: [],
      dms: [{ channelId: "dm1" }],
    })
    setLastMeLocation("/c/me/dm1")
    ingestDms(db, { conversations: [] })
    expect(db.collections.channels.get("dm1")).toBeUndefined()
    expect(db.collections.channelMemberships.get("dm1:viewer:access")).toBeUndefined()
    expect(db.collections.channelMemberships.get("dm1:peer:access")).toBeUndefined()
    expect(db.collections.messages.get("dm-message")).toBeUndefined()
    expect(db.collections.profiles.get("peer")).toBeUndefined()
    expect(unreadProjection.projectUnread("inbox-unreads", "dm1", true)).toBe(false)
    expect(db.queryClient.getQueryData<{ dms: unknown[] }>(
      communityKeys.inboxUnreads(),
    )?.dms).toEqual([])
    expect(getLastMeLeaf()).toBeNull()

    ingestServers(db, { servers: [] })
    expect(db.collections.servers.get("s1")).toBeUndefined()
    expect(db.collections.serverMemberships.get("s1:viewer")).toBeUndefined()
  })

  it("keeps profiles referenced only by a surviving server owner", async () => {
    const db = await registry()
    ingestServers(db, {
      servers: [
        {
          id: "s1", name: "Removed", initial: "R", active: false, unread: false,
          mentions: 0, ownerId: "owner-removed",
        },
        {
          id: "s2", name: "Kept", initial: "K", active: false, unread: false,
          mentions: 0, ownerId: "owner-kept",
        },
      ],
    })
    for (const [userId, name] of [["owner-removed", "Removed"], ["owner-kept", "Kept"]] as const) {
      projectCommunityWsEventToDb(db.queryClient, {
        type: "community:profile.update",
        userId,
        name,
        discriminator: "0001",
        aboutMe: "",
        bannerColor: null,
        kind: "human",
        ownerUserId: null,
      } as CommunityWsEvent)
    }

    ingestServers(db, {
      servers: [{
        id: "s2", name: "Kept", initial: "K", active: false, unread: false,
        mentions: 0, ownerId: "owner-kept",
      }],
    })

    expect(db.collections.profiles.get("owner-removed")).toBeUndefined()
    expect(db.collections.profiles.get("owner-kept")).toMatchObject({ name: "Kept" })
  })

  it("keeps canonical profile patches monotonic before hydration and across sparse authors", async () => {
    const db = await registry()
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:status.update",
      userId: "peer",
      statusEmoji: "🌱",
      statusText: "Growing",
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:identity.update",
      userId: "peer",
      avatar: "/peer-v5.png",
      avatarVersion: 5,
    } as CommunityWsEvent)
    ingestDms(db, {
      conversations: [{
        id: "dm1", userId: "peer", name: "Peer", discriminator: "0002",
        avatar: "/stale.png", avatarVersion: 4, status: "offline", preview: "",
      }],
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:profile.update",
      userId: "peer",
      name: "Rich Peer",
      discriminator: "0002",
      aboutMe: "rich bio",
      bannerColor: "#fff",
      kind: "human",
      ownerUserId: null,
    } as CommunityWsEvent)
    ingestMessages(db, "dm1", [{
      id: "m1", type: "chat", authorId: "peer", authorName: "Sparse Peer",
      authorAvatar: "/older.png", authorAvatarVersion: 3,
      content: "hello", createdAt: "2026-09-25T00:00:00.000Z",
    }])
    expect(db.collections.profiles.get("peer")).toMatchObject({
      name: "Sparse Peer",
      discriminator: "0002",
      avatar: "/peer-v5.png",
      avatarVersion: 5,
      aboutMe: "rich bio",
      bannerColor: "#fff",
      statusEmoji: "🌱",
      statusText: "Growing",
    })
  })

  it("purges the complete server closure while preserving DMs", async () => {
    const db = await registry()
    ingestServers(db, {
      servers: [{
        id: "s1",
        name: "Alook",
        initial: "A",
        active: false,
        unread: false,
        mentions: 0,
        ownerId: "viewer",
      }],
    })
    ingestServerDetail(db, {
      id: "s1",
      name: "Alook",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "General",
        channels: [{ id: "c1", name: "chat", active: false, unread: false }],
      }],
    })
    ingestDms(db, {
      conversations: [{
        id: "dm1",
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 1,
        status: "offline",
        preview: "",
      }],
    })
    purgeCommunityServer(db, "s1")
    expect(db.collections.servers.get("s1")).toBeUndefined()
    expect(db.collections.categories.get("cat1")).toBeUndefined()
    expect(db.collections.channels.get("c1")).toBeUndefined()
    expect(db.collections.channels.get("dm1")).toBeDefined()
  })

  it("purges only the selected child channel without removing its parent or siblings", async () => {
    const db = await registry()
    ingestServerDetail(db, {
      id: "s1",
      name: "Alook",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "General",
        channels: [{ id: "c1", name: "chat", active: false, unread: false }],
      }],
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.child_create",
      parentChannelId: "c1",
      parentMessageId: "m1",
      channel: {
        id: "thread1",
        name: "Thread one",
        type: "thread",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.child_create",
      parentChannelId: "c1",
      parentMessageId: "m2",
      channel: {
        id: "thread2",
        name: "Thread two",
        type: "thread",
        createdAt: "2026-09-25T00:00:01.000Z",
      },
    } as CommunityWsEvent)

    purgeCommunityChannel(db, "thread1")

    expect(db.collections.channels.get("thread1")).toBeUndefined()
    expect(db.collections.channels.get("c1")).toBeDefined()
    expect(db.collections.channels.get("thread2")).toBeDefined()
  })

  it("projects structural, message, and profile websocket deltas into canonical rows", async () => {
    const db = await registry()
    ingestServers(db, {
      servers: [{
        id: "s1",
        name: "Alook",
        initial: "A",
        active: false,
        unread: false,
        mentions: 0,
        ownerId: "viewer",
      }],
    })
    ingestDms(db, {
      conversations: [{
        id: "dm1",
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 1,
        status: "offline",
        preview: "",
      }],
    })

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.create",
      serverId: "s1",
      channel: {
        id: "c1",
        name: "general",
        type: "text",
        categoryId: null,
        position: 2,
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.create",
      channelId: "c1",
      serverId: "s1",
      message: {
        id: "m1",
        type: "chat",
        authorId: "peer",
        authorName: "Peer",
        content: "hello",
        createdAt: "2026-09-25T00:00:01.000Z",
      },
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:status.update",
      userId: "peer",
      statusEmoji: "🌱",
      statusText: "Growing",
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:identity.update",
      userId: "peer",
      avatar: "/peer-v2.png",
      avatarVersion: 2,
    } as CommunityWsEvent)

    expect(db.collections.channels.get("c1")).toMatchObject({
      serverId: "s1",
      categoryId: null,
      position: 2,
    })
    expect(db.collections.messages.get("m1")).toMatchObject({
      channelId: "c1",
      content: "hello",
    })
    expect(db.collections.profiles.get("peer")).toMatchObject({
      statusEmoji: "🌱",
      statusText: "Growing",
      avatar: "/peer-v2.png",
      avatarVersion: 2,
    })
  })

  it("normalizes message-bearing surfaces into one identity for edits, reactions, and purge", async () => {
    const db = await registry()
    const uninstall = installCommunityDbSync(db.queryClient, db)
    const message = (id: string, content: string) => ({
      id,
      type: "chat" as const,
      authorId: "peer",
      authorName: "Peer",
      content,
      createdAt: "2026-09-25T00:00:00.000Z",
      reactions: [],
    })
    db.queryClient.setQueryData(communityKeys.pins("c1"), { pins: [message("pin", "pin")] })
    db.queryClient.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "mention", channelId: "c1", m: message("mention-message", "mention") }],
    })
    db.queryClient.setQueryData(communityKeys.inboxMarked(), {
      marked: [{ id: "mark", channelId: "c1", m: message("marked-message", "marked") }],
    })
    db.queryClient.setQueryData(communityKeys.forumFeed("c1", null), {
      pages: [{
        included: {
          parentMessages: [{
            id: "forum-message",
            channelId: "c1",
            type: "chat",
            authorId: "peer",
            authorName: "Peer",
            authorImage: null,
            authorAvatarVersion: 0,
            content: "forum",
            createdAt: "2026-09-25T00:00:00.000Z",
            seq: 1,
          }],
        },
      }],
      pageParams: [null],
    })

    expect([...db.collections.messages.keys()].sort()).toEqual([
      "forum-message",
      "marked-message",
      "mention-message",
      "pin",
    ])
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.edited",
      channelId: "c1",
      messageId: "pin",
      content: "edited",
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:reaction.add",
      channelId: "c1",
      messageId: "pin",
      userId: "viewer",
      emoji: "👍",
    } as CommunityWsEvent)
    expect(db.collections.messages.get("pin")).toMatchObject({
      content: "edited",
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["viewer"] }],
    })
    purgeCommunityChannel(db, "c1")
    expect(db.collections.messages.size).toBe(0)
    uninstall()
  })

  it("normalizes a cold single-message opener through child-channel ownership", async () => {
    const db = await registry()
    const uninstall = installCommunityDbSync(db.queryClient, db)
    ingestServers(db, {
      servers: [{
        id: "s1", name: "Server", initial: "S", active: false, unread: false,
        mentions: 0, ownerId: "viewer",
      }],
    })
    ingestServerDetail(db, {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "Forum",
        channels: [{ id: "forum1", name: "forum", active: false, unread: false, type: "forum" }],
      }],
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.child_create",
      parentChannelId: "forum1",
      parentMessageId: "opener",
      channel: {
        id: "thread1",
        name: "Thread",
        type: "thread",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    } as CommunityWsEvent)

    db.queryClient.setQueryData(communityKeys.message("opener"), {
      id: "opener",
      type: "chat",
      authorId: "peer",
      authorName: "Peer",
      authorAvatar: "P",
      authorAvatarVersion: 0,
      content: "cold opener",
      createdAt: "2026-09-25T00:00:00.000Z",
    })

    expect(db.collections.messages.get("opener")).toMatchObject({
      channelId: "forum1",
      content: "cold opener",
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.edited",
      channelId: "forum1",
      messageId: "opener",
      content: "edited opener",
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:reaction.add",
      channelId: "forum1",
      messageId: "opener",
      userId: "viewer",
      emoji: "👍",
    } as CommunityWsEvent)
    expect(db.collections.messages.get("opener")).toMatchObject({
      content: "edited opener",
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["viewer"] }],
    })
    uninstall()
  })
})

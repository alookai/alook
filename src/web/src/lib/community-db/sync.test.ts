import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommunityWsEvent } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { rememberMessageAccessScope } from "./message-access-scope"
import { getLastChannel, setLastChannel } from "@/lib/community/last-channel"
import {
  getLastMeLeaf,
  setLastMeLocation,
} from "@/lib/community/last-me-location"
import {
  createCommunityDbRegistry,
  getCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "./collections"
import {
  ingestDms,
  ingestAttentionSnapshot,
  ingestMessages,
  ingestReadStateSnapshot,
  ingestServerDetail,
  ingestServers,
  installCommunityDbSync,
  captureCommunityLiveSnapshotToken,
  clearAttentionOptimistically,
  clearAttentionScopeOptimistically,
  commitAttentionOptimisticSnapshot,
  commitAttentionScopeOptimisticSnapshot,
  patchCanonicalCommunityMessage,
  publishCommunityDmSummary,
  publishCommunityMessages,
  publishCommunityChannelDirectory,
  publishCommunityServerFields,
  publishCommunityChannelFields,
  publishCommunityLiveSnapshot as publishCommunityLiveSnapshotWithProof,
  publishAccountAttentionSnapshot,
  projectCommunityWsEventToDb,
  purgeCommunityChannel,
  purgeCommunityServer,
  removeAttentionItemsOptimistically,
  restoreAttentionScopeOptimisticSnapshot,
  type CommunityLiveSnapshot,
} from "./sync"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"

const registries: CommunityDbRegistry[] = []
const unregisters: Array<() => void> = []

async function registry() {
  const result = createCommunityDbRegistry(new QueryClient(), "viewer")
  registries.push(result)
  await result.preload()
  unregisters.push(registerCommunityDbRegistry(result))
  return result
}

function publishCommunityLiveSnapshot(
  queryClient: QueryClient,
  snapshot: CommunityLiveSnapshot,
) {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  if (snapshot.kind === "read-state") {
    return publishCommunityLiveSnapshotWithProof(queryClient, {
      snapshot,
      proof: {
        kind: "read-state",
        token,
        signal: undefined,
        requestGeneration: 0,
        currentRequestGeneration: 0,
        targetRevision: null,
      },
    })
  }
  return publishCommunityLiveSnapshotWithProof(queryClient, {
    snapshot,
    proof: { kind: "structural", token, signal: undefined },
  })
}

afterEach(async () => {
  unregisters.splice(0).forEach((unregister) => unregister())
  await Promise.all(registries.splice(0).map((entry) => entry.cleanup()))
  vi.unstubAllGlobals()
})

describe("community DB sync", () => {
  it.each(["newer-ws", "original"])("preserves the named WS write %s while confirming independent server fields and rejecting the older whole snapshot", async (name) => {
    const db = await registry()
    const original = { id: "s1", name: "original", description: "before", initial: "O", active: false, unread: false, mentions: 0, ownerId: "viewer" }
    ingestServers(db, { servers: [original] })
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    projectCommunityWsEventToDb(db.queryClient, { type: "community:server.update", serverId: "s1", changes: { name } })
    publishCommunityServerFields(db.queryClient, "s1", { name: "old-confirmation", description: "confirmed" }, { token, signal: undefined })
    expect(db.collections.servers.get("s1")).toMatchObject({ name, description: "confirmed" })
    publishCommunityLiveSnapshotWithProof(db.queryClient, { snapshot: { kind: "servers", data: { servers: [original] } }, proof: { kind: "structural", token, signal: undefined } })
    expect(db.collections.servers.get("s1")).toMatchObject({ name, description: "confirmed" })
  })

  it("cannot resurrect a deleted channel through a confirmed field patch or the older snapshot", async () => {
    const db = await registry()
    const original = { id: "s1", name: "Server", discriminator: "0001", description: "", ownerId: "viewer", icon: null, categories: [{ id: "cat1", name: "General", channels: [{ id: "c1", name: "old", active: false, unread: false }] }] }
    ingestServerDetail(db, original)
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    projectCommunityWsEventToDb(db.queryClient, { type: "community:channel.delete", serverId: "s1", channelId: "c1" })
    expect(() => publishCommunityChannelFields(db.queryClient, "c1", { name: "confirmed" }, { token, signal: undefined })).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(() => publishCommunityLiveSnapshotWithProof(db.queryClient, { snapshot: { kind: "server-detail", data: original }, proof: { kind: "structural", token, signal: undefined } })).toThrow(expect.objectContaining({ name: "AbortError" }))
    const current = captureCommunityLiveSnapshotToken(db.queryClient)
    expect(publishCommunityChannelFields(db.queryClient, "c1", { name: "confirmed" }, { token: current, signal: undefined })).toBe(false)
    expect(db.collections.channels.has("c1")).toBe(false)
  })

  it("does not regress a known channel subtype when directory transport omits it", async () => {
    const db = await registry()
    ingestServers(db, { servers: [{
      id: "s1", name: "Server", initial: "S", active: false, unread: false,
      mentions: 0, ownerId: "viewer",
    }] })
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [{
        id: "cat1", name: "General", channels: [{
          id: "forum1", name: "Forum", active: false, unread: false, type: "forum",
        }],
      }],
    })

    expect(publishCommunityChannelDirectory(db.queryClient, {
      directory: [{
        id: "s1",
        name: "Server",
        discriminator: "0001",
        channels: [{ id: "forum1", name: "Forum renamed" }],
      }],
      proof: {
        token: captureCommunityLiveSnapshotToken(db.queryClient),
        signal: undefined,
      },
    })).toBe("published")
    expect(db.collections.channels.get("forum1")).toMatchObject({
      name: "Forum renamed",
      type: "forum",
    })
  })

  it("ingests an unknown legacy directory channel as text", async () => {
    const db = await registry()

    expect(publishCommunityChannelDirectory(db.queryClient, {
      directory: [{
        id: "s1",
        name: "Server",
        discriminator: "0001",
        channels: [{ id: "c1", name: "General" }],
      }],
      proof: {
        token: captureCommunityLiveSnapshotToken(db.queryClient),
        signal: undefined,
      },
    })).toBe("published")
    expect(db.collections.channels.get("c1")).toMatchObject({
      name: "General",
      type: "text",
    })
  })

  it("keeps anonymous canonical ingestion free of viewer access rows", async () => {
    const db = createCommunityDbRegistry(new QueryClient(), null)
    registries.push(db)
    await db.preload()

    ingestServers(db, { servers: [{
      id: "s1", name: "Server", initial: "S", active: false, unread: false,
      mentions: 0, ownerId: "owner",
    }] })
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "owner", categories: [{
        id: "cat1", name: "General", channels: [{
          id: "c1", name: "general", active: false, unread: false,
        }],
      }],
    })

    expect([...db.collections.serverMemberships.values()]).toEqual([])
    expect([...db.collections.channelMemberships.values()]).toEqual([])
  })

  it.each(["signal", "account", "access"] as const)(
    "rejects a structurally stale %s proof before destructive replacement",
    async (race) => {
      const db = await registry()
      db.runtime.ws.actions.activateProfileAccount(`viewer-${race}`)
      ingestDms(db, {
        conversations: [{
          id: "dm-current",
          userId: "peer",
          name: "Peer",
          discriminator: "0001",
          avatar: "P",
          status: "offline",
          preview: "",
        }],
      })
      const token = captureCommunityLiveSnapshotToken(db.queryClient)
      const controller = new AbortController()
      if (race === "signal") controller.abort()
      else if (race === "account") {
        db.runtime.ws.actions.activateProfileAccount("viewer-next")
      } else {
        db.runtime.ws.setState((state) => ({ ...state,  accessEpoch: state.accessEpoch + 1 }))
      }

      expect(() => publishCommunityLiveSnapshotWithProof(db.queryClient, {
        snapshot: { kind: "dms", data: { conversations: [] } },
        proof: { kind: "structural", token, signal: controller.signal },
      })).toThrowError(expect.objectContaining({ name: "AbortError" }))
      expect(db.collections.channels.get("dm-current")).toBeDefined()
    },
  )

  it("keeps a projected Inbox DM over an older authoritative snapshot", async () => {
    const db = await registry()
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    const dm = {
      id: "dm-first-click",
      userId: "peer",
      name: "Peer",
      discriminator: "0001",
      avatar: "P",
      status: "offline" as const,
      preview: "",
      unread: false,
    }

    expect(publishCommunityDmSummary(db.queryClient, dm)).toBe("published")
    publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: { kind: "dms", data: { conversations: [] } },
      proof: { kind: "structural", token, signal: undefined },
    })

    expect(db.collections.channels.get(dm.id)).toMatchObject({ id: dm.id, type: "dm" })
    expect(db.collections.channelMemberships.get(`${dm.id}:viewer:access`)).toBeDefined()
    expect(db.collections.channelMemberships.get(`${dm.id}:peer:access`)).toBeDefined()
    expect(db.collections.profiles.get("peer")).toMatchObject({ name: "Peer" })
  })

  it("preserves a same-entity WS message edit over an older HTTP response", async () => {
    const db = await registry()
    const staleMessage = {
      id: "m1",
      type: "chat" as const,
      seq: 1,
      content: "stale HTTP",
      createdAt: "2026-09-26T00:00:00.000Z",
    }
    ingestMessages(db, "c1", [staleMessage])
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.edited",
      channelId: "c1",
      messageId: "m1",
      content: "new WS value",
    } as CommunityWsEvent)
    publishCommunityMessages(db.queryClient, {
      channelId: "c1",
      messages: [staleMessage],
      proof: { token, signal: undefined },
    })

    expect(db.collections.messages.get("m1")?.content).toBe("new WS value")
  })

  it("preserves a local canonical message patch over an older HTTP response", async () => {
    const db = await registry()
    const staleMessage = {
      id: "m-local",
      type: "chat" as const,
      seq: 1,
      content: "message",
      createdAt: "2026-09-26T00:00:00.000Z",
      reactions: [{ emoji: "👍", count: 1, me: false }],
    }
    ingestMessages(db, "c1", [staleMessage])
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    patchCanonicalCommunityMessage(db.queryClient, "m-local", (message) => ({
      ...message,
      reactions: [{ emoji: "👍", count: 2, me: true }],
    }))
    publishCommunityMessages(db.queryClient, {
      channelId: "c1",
      messages: [staleMessage],
      proof: { token, signal: undefined },
    })

    expect(db.collections.messages.get("m-local")?.reactions).toEqual([
      { emoji: "👍", count: 2, me: true },
    ])
  })

  it("merges a WS message edit for an absent row into an older HTTP response", async () => {
    const db = await registry()
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.edited",
      channelId: "c1",
      messageId: "m1",
      content: "new WS value",
    } as CommunityWsEvent)
    publishCommunityMessages(db.queryClient, {
      channelId: "c1",
      messages: [{
        id: "m1",
        type: "chat",
        seq: 1,
        content: "stale HTTP",
        createdAt: "2026-09-26T00:00:00.000Z",
      }],
      proof: { token, signal: undefined },
    })

    expect(db.collections.messages.get("m1")?.content).toBe("new WS value")

    db.collections.messages.utils.writeDelete("m1")
    db.queryClient.setQueryData(
      communityKeys.communityDbCollection("viewer", "messages"),
      [],
    )
    publishCommunityMessages(db.queryClient, {
      channelId: "c1",
      messages: [{
        id: "m1",
        type: "chat",
        seq: 1,
        content: "stale HTTP replay",
        createdAt: "2026-09-26T00:00:00.000Z",
      }],
      proof: { token, signal: undefined },
    })
    expect(db.collections.messages.get("m1")).toBeUndefined()
  })

  it("does not retain pending closures for WS patches that hit an existing row", async () => {
    const db = await registry()
    ingestMessages(db, "c1", [{
      id: "m1",
      type: "chat",
      seq: 1,
      content: "seed",
      createdAt: "2026-09-26T00:00:00.000Z",
    }])
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    for (let index = 0; index < 100; index += 1) {
      projectCommunityWsEventToDb(db.queryClient, {
        type: "community:message.edited",
        channelId: "c1",
        messageId: "m1",
        content: `edit ${index}`,
      } as CommunityWsEvent)
    }

    db.collections.messages.utils.writeDelete("m1")
    db.queryClient.setQueryData(
      communityKeys.communityDbCollection("viewer", "messages"),
      [],
    )
    publishCommunityMessages(db.queryClient, {
      channelId: "c1",
      messages: [{
        id: "m1",
        type: "chat",
        seq: 1,
        content: "stale HTTP",
        createdAt: "2026-09-26T00:00:00.000Z",
      }],
      proof: { token, signal: undefined },
    })

    expect(db.collections.messages.get("m1")).toBeUndefined()
  })

  it("preserves same-entity WS server/channel writes over older HTTP", async () => {
    const db = await registry()
    const detail = {
      id: "s1",
      name: "Stale server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "cat1",
        name: "General",
        channels: [{
          id: "c1",
          name: "stale channel",
          active: false,
          unread: false,
          type: "text" as const,
        }, {
          id: "c2",
          name: "deleted channel",
          active: false,
          unread: false,
          type: "text" as const,
        }],
      }],
    }
    ingestServers(db, { servers: [{
      id: "s1", name: "Stale server", initial: "S", active: false,
      unread: false, mentions: 0, ownerId: "viewer",
    }] })
    ingestServerDetail(db, detail)
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:server.update",
      serverId: "s1",
      changes: { name: "Fresh server" },
    } as CommunityWsEvent)
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.update",
      serverId: "s1",
      channelId: "c1",
      changes: { name: "fresh channel" },
    } as CommunityWsEvent)
    publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: { kind: "server-detail", data: detail },
      proof: { kind: "structural", token, signal: undefined },
    })

    expect(db.collections.servers.get("s1")?.name).toBe("Fresh server")
    expect(db.collections.channels.get("c1")?.name).toBe("fresh channel")
  })

  it("promotes server detail completeness over a newer WS server update", async () => {
    const db = await registry()
    ingestServers(db, { servers: [{
      id: "s1", name: "Stale server", initial: "S", active: false,
      unread: false, mentions: 0, ownerId: "viewer",
    }] })
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:server.update",
      serverId: "s1",
      changes: { name: "Fresh server" },
    } as CommunityWsEvent)
    publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: {
        kind: "server-detail",
        data: {
          id: "s1", name: "Stale server", discriminator: "0001", description: "",
          icon: null, ownerId: "viewer", categories: [{
            id: "cat1", name: "General", channels: [{
              id: "c1", name: "general", active: false, unread: false,
            }],
          }],
        },
      },
      proof: { kind: "structural", token, signal: undefined },
    })

    expect(db.collections.servers.get("s1")).toMatchObject({
      name: "Fresh server",
      detailComplete: true,
    })
    expect(db.collections.channels.get("c1")?.name).toBe("general")
  })

  it("merges a WS channel update for an absent row into older HTTP", async () => {
    const db = await registry()
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    const detail = {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [{
        id: "cat1", name: "General", channels: [{
          id: "c1", name: "stale channel", active: false, unread: false,
          type: "text" as const,
        }],
      }],
    }

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.update",
      serverId: "s1",
      channelId: "c1",
      changes: { name: "fresh channel" },
    } as CommunityWsEvent)
    publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: { kind: "server-detail", data: detail },
      proof: { kind: "structural", token, signal: undefined },
    })

    expect(db.collections.channels.get("c1")?.name).toBe("fresh channel")
  })

  it("does not revive a channel deleted after an HTTP request starts", async () => {
    const db = await registry()
    const detail = {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [{
        id: "cat1", name: "General", channels: [{
          id: "c1", name: "deleted channel", active: false, unread: false,
          type: "text" as const,
        }],
      }],
    }
    ingestServers(db, { servers: [{
      id: "s1", name: "Server", initial: "S", active: false,
      unread: false, mentions: 0, ownerId: "viewer",
    }] })
    ingestServerDetail(db, detail)
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.delete",
      serverId: "s1",
      channelId: "c1",
    } as CommunityWsEvent)
    expect(() => publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: { kind: "server-detail", data: detail },
      proof: { kind: "structural", token, signal: undefined },
    })).toThrowError(expect.objectContaining({ name: "AbortError" }))
    expect(db.collections.channels.get("c1")).toBeUndefined()
  })

  it("keeps an absent WS-deleted channel out of an older HTTP response", async () => {
    const db = await registry()
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    const detail = {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [{
        id: "cat1", name: "General", channels: [{
          id: "c1", name: "deleted channel", active: false, unread: false,
          type: "text" as const,
        }],
      }],
    }

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.delete",
      serverId: "s1",
      channelId: "c1",
    } as CommunityWsEvent)
    expect(publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: { kind: "server-detail", data: detail },
      proof: { kind: "structural", token, signal: undefined },
    })).toBe("published")

    expect(db.collections.channels.get("c1")).toBeUndefined()
  })

  it("rejects a superseded read-state freshness proof before replacement", async () => {
    const db = await registry()
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "read-state",
      data: {
        revision: 1,
        readStates: [
          { channelId: "c1", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 1 },
          { channelId: "c2", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 2 },
        ],
      },
    })
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    expect(publishCommunityLiveSnapshotWithProof(db.queryClient, {
      snapshot: {
        kind: "read-state",
        data: {
          revision: 2,
          readStates: [{
            channelId: "c1",
            lastReadMessageId: null,
            lastReadAt: "2026-09-26T00:00:01.000Z",
            lastReadSeq: 3,
          }],
        },
      },
      proof: {
        kind: "read-state",
        token,
        signal: undefined,
        requestGeneration: 1,
        currentRequestGeneration: 2,
        targetRevision: 2,
      },
    })).toBe("superseded")
    expect(db.collections.readStates.get("c2")).toBeDefined()
  })

  it("never treats raw server-detail query keys as canonical writers", async () => {
    const db = await registry()
    const uninstall = installCommunityDbSync(db.queryClient, db)

    db.queryClient.setQueryData(communityKeys.channelRefDirectory(), [{
      channelId: "channel-directory-only",
      serverId: "not-a-detail",
    }])
    db.queryClient.setQueryData(communityKeys.server("__none__"), { sentinel: true })
    db.queryClient.setQueryData(communityKeys.server("__pending__"), { sentinel: true })
    expect(db.collections.servers.size).toBe(0)

    db.queryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [],
    })
    expect(db.collections.servers.get("s1")).toBeUndefined()
    uninstall()
  })

  it("does not replay hydrated or setQueryData transport payloads into canonical DB", async () => {
    const db = await registry()
    db.queryClient.setQueryData(communityKeys.servers(), { servers: [{
      id: "s1", name: "Server", initial: "S", active: false, unread: false,
      mentions: 0, ownerId: "viewer",
    }] })
    db.queryClient.setQueryData(communityKeys.dms(), { conversations: [{
      id: "dm1", userId: "peer", name: "Peer", discriminator: "0002",
      avatar: "P", avatarVersion: 1, status: "offline", preview: "hello",
    }] })
    db.queryClient.getQueryCache().build(db.queryClient, {
      queryKey: ["community", "pending-ingest"],
      queryFn: async () => null,
    })
    const uninstall = installCommunityDbSync(db.queryClient, db)
    await db.preload()
    expect(db.collections.servers.get("s1")).toBeUndefined()
    expect(db.collections.channels.get("dm1")).toBeUndefined()
    db.queryClient.setQueryData(communityKeys.folders(), {
      folders: [{
        id: "f1", name: "Folder", position: 1,
        servers: [{ id: "s1", name: "Server", initial: "S", icon: null }],
      }],
    })
    db.queryClient.setQueryData(communityKeys.channelMeta("s1", "c1"), {
      id: "c1", serverId: "s1", name: "chat", type: "text",
      parentChannelId: null, parentMessageId: null, creatorId: null,
      archived: 0, lastMessageAt: null,
    })
    db.queryClient.setQueryData(communityKeys.channelMeta("s1", "c1"), {
      id: "c1", serverId: "s1", name: "chat renamed", type: "text",
      parentChannelId: null, parentMessageId: null, creatorId: null,
      archived: 1, lastMessageAt: null,
    })
    db.queryClient.setQueryData(communityKeys.channelMeta("s1", "ignored"), {
      id: "ignored", serverId: "s1", name: "ignored", type: "dm",
      parentChannelId: null, parentMessageId: null, creatorId: null,
      archived: 0, lastMessageAt: null,
    })
    db.queryClient.setQueryData(communityKeys.channelMessages("c1"), {
      pages: [{ messages: [{
        id: "page-message", type: "chat", authorId: "peer", authorName: "Peer",
        content: "page", createdAt: "2026-09-25T00:00:00.000Z",
      }] }],
      pageParams: [null],
    })
    db.queryClient.setQueryData(communityKeys.messageContext("channel", "c1", 1), {
      messages: [{
        id: "context-message", type: "chat", authorId: "peer", authorName: "Peer",
        content: "context", createdAt: "2026-09-25T00:00:01.000Z",
      }],
    })
    db.queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [{
        channelId: "c1", lastReadMessageId: "page-message",
        lastReadAt: "2026-09-25T00:00:02.000Z", lastReadSeq: 2,
      }],
    })
    db.queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [
        { serverId: "s1", level: "all" },
        { channelId: "c1", level: "mentions" },
        { serverId: "s1", channelId: "c1", level: "nothing" },
      ],
      server: {},
      channel: {},
    })
    db.queryClient.setQueryData(communityKeys.folders(), {
      folders: [{ id: "f2", name: "Replacement", position: 0, servers: [] }],
    })
    db.queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [{ channelId: "c1", level: "nothing" }],
      server: {},
      channel: {},
    })
    db.queryClient.setQueryData(communityKeys.channelMessages("empty"), {})
    db.queryClient.setQueryData(communityKeys.forumFeed("c1", "all"), {})
    db.queryClient.setQueryData(communityKeys.forumFeed("c1", "invalid"), {
      pages: [{ included: { parentMessages: [{ id: 42, channelId: "c1" }] } }],
      pageParams: [null],
    })

    expect(db.collections.folders.get("f1")).toBeUndefined()
    expect(db.collections.folders.get("f2")).toBeUndefined()
    expect(db.collections.folderItems.get("f1:s1")).toBeUndefined()
    expect(db.collections.channels.get("c1")).toBeUndefined()
    expect(db.collections.channels.get("ignored")).toBeUndefined()
    expect(db.collections.messages.get("page-message")).toBeUndefined()
    expect(db.collections.messages.get("context-message")).toBeUndefined()
    expect(db.collections.readStateClock.get("account")).toBeUndefined()
    expect([...db.collections.notificationSettings.keys()]).toEqual([])
    uninstall()
  })

  it("never deletes or revokes from cached-success replay", async () => {
    const db = await registry()
    const uninstall = installCommunityDbSync(db.queryClient, db)
    const server = (id: string) => ({
      id,
      name: id,
      initial: id[0]!.toUpperCase(),
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    })
    const dm = (id: string, userId: string) => ({
      id,
      userId,
      name: userId,
      discriminator: "0001",
      avatar: userId[0]!.toUpperCase(),
      avatarVersion: 1,
      status: "offline" as const,
      preview: "",
    })
    const detail = (channelIds: string[]) => ({
      id: "merge-s1",
      name: "Merge",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "merge-cat",
        name: "General",
        channels: channelIds.map((id) => ({
          id,
          name: id,
          active: false,
          unread: false,
        })),
      }],
    })

    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "servers",
      data: { servers: [server("merge-s1"), server("merge-s2")] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "server-detail",
      data: detail(["merge-c1", "merge-c2"]),
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "dms",
      data: { conversations: [dm("merge-dm1", "peer1"), dm("merge-dm2", "peer2")] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "folders",
      data: { folders: [
        { id: "merge-f1", name: "One", position: 0, servers: [] },
        { id: "merge-f2", name: "Two", position: 1, servers: [] },
      ] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "read-state",
      data: {
        revision: 1,
        readStates: [
          { channelId: "merge-c1", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 1 },
          { channelId: "merge-c2", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 2 },
        ],
      },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "notification-settings",
      data: {
        raw: [
          { serverId: "merge-s1", level: "all" },
          { channelId: "merge-c2", level: "mentions" },
        ],
        server: {},
        channel: {},
      },
    })

    db.queryClient.setQueryData(communityKeys.servers(), {
      servers: [server("merge-s1")],
    })
    db.queryClient.setQueryData(communityKeys.server("merge-s1"), detail(["merge-c1"]))
    db.queryClient.setQueryData(communityKeys.dms(), {
      conversations: [dm("merge-dm1", "peer1")],
    })
    db.queryClient.setQueryData(communityKeys.folders(), {
      folders: [{ id: "merge-f1", name: "One", position: 0, servers: [] }],
    })
    db.queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [{
        channelId: "merge-c1",
        lastReadMessageId: null,
        lastReadAt: "2026-09-26T00:00:01.000Z",
        lastReadSeq: 3,
      }],
    })
    db.queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [{ serverId: "merge-s1", level: "nothing" }],
      server: {},
      channel: {},
    })
    void db.queryClient.invalidateQueries({
      queryKey: communityKeys.servers(),
      exact: true,
      refetchType: "none",
    })

    expect(db.collections.servers.get("merge-s2")).toBeDefined()
    expect(db.runtime.ws.get().revokedServerIds.has("merge-s2")).toBe(false)
    expect(db.collections.channels.get("merge-c2")).toBeDefined()
    expect(db.collections.channels.get("merge-dm2")).toBeDefined()
    expect(db.collections.folders.get("merge-f2")).toBeDefined()
    expect(db.collections.readStates.get("merge-c2")).toBeDefined()
    expect(db.collections.notificationSettings.get("channel:merge-c2")).toBeDefined()
    uninstall()
  })

  it("gives destructive replacement only to live publishers and explicit events", async () => {
    const db = await registry()
    const server = (id: string) => ({
      id,
      name: id,
      initial: id[0]!.toUpperCase(),
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    })
    const dm = (id: string, userId: string) => ({
      id,
      userId,
      name: userId,
      discriminator: "0001",
      avatar: userId[0]!.toUpperCase(),
      avatarVersion: 1,
      status: "offline" as const,
      preview: "",
    })
    const detail = (channelIds: string[]) => ({
      id: "live-s1",
      name: "Live",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [{
        id: "live-cat",
        name: "General",
        channels: channelIds.map((id) => ({
          id,
          name: id,
          active: false,
          unread: false,
        })),
      }],
    })

    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "servers",
      data: { servers: [server("live-s1"), server("live-s2")] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "server-detail",
      data: detail(["live-c1", "live-c2"]),
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "dms",
      data: { conversations: [dm("live-dm1", "peer1"), dm("live-dm2", "peer2")] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "folders",
      data: { folders: [
        {
          id: "live-f1",
          name: "One",
          position: 0,
          servers: [{ id: "live-s1", name: "Live one", initial: "L", icon: null }],
        },
        {
          id: "live-f2",
          name: "Two",
          position: 1,
          servers: [{ id: "live-s2", name: "Live two", initial: "L", icon: null }],
        },
      ] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "read-state",
      data: {
        revision: 1,
        readStates: [
          { channelId: "live-c1", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 1 },
          { channelId: "live-c2", lastReadMessageId: null, lastReadAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 2 },
        ],
      },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "notification-settings",
      data: {
        raw: [
          { serverId: "live-s1", level: "all" },
          { channelId: "live-c2", level: "mentions" },
        ],
        server: {},
        channel: {},
      },
    })

    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "server-detail",
      data: detail(["live-c1"]),
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "dms",
      data: { conversations: [dm("live-dm1", "peer1")] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "folders",
      data: { folders: [{
        id: "live-f1",
        name: "One",
        position: 0,
        servers: [{ id: "live-s1", name: "Live one", initial: "L", icon: null }],
      }] },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "read-state",
      data: {
        revision: 2,
        readStates: [{
          channelId: "live-c1",
          lastReadMessageId: null,
          lastReadAt: "2026-09-26T00:00:01.000Z",
          lastReadSeq: 3,
        }],
      },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "notification-settings",
      data: {
        raw: [{ serverId: "live-s1", level: "nothing" }],
        server: {},
        channel: {},
      },
    })
    publishCommunityLiveSnapshot(db.queryClient, {
      kind: "servers",
      data: { servers: [server("live-s1")] },
    })

    expect(db.collections.servers.get("live-s2")).toBeUndefined()
    expect(db.runtime.ws.get().revokedServerIds.has("live-s2")).toBe(true)
    expect(db.collections.channels.get("live-c2")).toBeUndefined()
    expect(db.runtime.ws.actions.isChannelAccessRevoked("live-c2", "live-s1")).toBe(true)
    expect(db.collections.channels.get("live-dm2")).toBeUndefined()
    expect(db.collections.folders.get("live-f2")).toBeUndefined()
    expect(db.collections.folderItems.get("live-f2:live-s2")).toBeUndefined()
    expect(db.collections.readStates.get("live-c2")).toBeUndefined()
    expect(db.collections.notificationSettings.get("channel:live-c2")).toBeUndefined()

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:server.delete",
      serverId: "live-s1",
    } as CommunityWsEvent)
    expect(db.collections.servers.get("live-s1")).toBeUndefined()
    expect(db.runtime.ws.get().revokedServerIds.has("live-s1")).toBe(true)
    db.runtime.ws.actions.grantServerAccess("live-s1")
    db.runtime.ws.actions.grantServerAccess("live-s2")
  })

  it("preserves completed server detail when the rail identity refreshes", async () => {
    const db = await registry()
    const rail = {
      id: "s1",
      name: "Server",
      initial: "S",
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    }

    ingestServers(db, { servers: [rail] })
    expect(db.collections.servers.get("s1")?.detailComplete).toBe(false)
    ingestServerDetail(db, {
      id: "s1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "viewer",
      categories: [],
    })
    expect(db.collections.servers.get("s1")?.detailComplete).toBe(true)
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer",
      categories: [{
        id: "cat1", name: "General",
        channels: [{ id: "c1", name: "chat", active: false, unread: false }],
      }],
    })
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer",
      categories: [{
        id: "cat1", name: "General",
        channels: [{ id: "c1", name: "renamed", active: false, unread: false }],
      }],
    })
    ingestServers(db, { servers: [rail] })
    expect(db.collections.servers.get("s1")?.detailComplete).toBe(true)
    expect(getCommunityDbRegistry(db.queryClient)).toBe(db)

    const originalGetQueryData = db.queryClient.getQueryData.bind(db.queryClient)
    const collectionKey = communityKeys.communityDbCollection(db.scopeId, "servers")
    const getQueryData = vi.spyOn(db.queryClient, "getQueryData").mockImplementation((key) => (
      JSON.stringify(key) === JSON.stringify(collectionKey)
        ? undefined
        : originalGetQueryData(key)
    ))
    ingestServers(db, { servers: [rail] })
    getQueryData.mockRestore()
  })

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

  it("lets one authoritative snapshot replace the complete prior attention truth", async () => {
    const db = await registry()
    const scope = {
      scopeId: "c1",
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
      lastAttentionSeq: 4,
      attentionCount: 1,
    }
    ingestAttentionSnapshot(db, {
      scopes: [scope],
      items: [],
      limit: 100,
      truncated: false,
    })
    const token = captureCommunityLiveSnapshotToken(db.queryClient)

    expect(publishAccountAttentionSnapshot(db.queryClient, {
      snapshot: { scopes: [], items: [], limit: 100, truncated: false },
      proof: { token, signal: undefined },
    })).toBe("published")
    expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
  })

  it("hydrates new DMs while preserving richer existing channel state", async () => {
    const db = await registry()
    ingestDms(db, { conversations: [{
      id: "existing",
      userId: "peer-existing",
      name: "Existing",
      discriminator: "0002",
      avatar: "E",
      avatarVersion: 1,
      status: "offline",
      preview: "keep preview",
      activityAt: "2026-09-27T00:00:01.000Z",
      unread: false,
    }] })
    const existing = db.collections.channels.get("existing")!
    const patched = { ...existing, position: 7, muted: true }
    const channelKey = communityKeys.communityDbCollection(db.scopeId, "channels")
    db.collections.channels.utils.writeUpsert(patched)
    db.queryClient.setQueryData(channelKey, [patched])

    ingestAttentionSnapshot(db, {
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: {
        servers: [],
        channels: [],
        dms: [{
          id: "existing",
          userId: "peer-existing",
          name: "Existing",
          discriminator: "0002",
          avatar: "E",
          avatarVersion: 2,
          lastMessageAt: "2026-09-28T00:00:07.000Z",
          lastUnreadSeq: 7,
        }, {
          id: "new",
          userId: "peer-new",
          name: "New",
          discriminator: "0003",
          avatar: "N",
          avatarVersion: 1,
          lastMessageAt: "2026-09-28T00:00:08.000Z",
          lastUnreadSeq: 8,
        }],
        profiles: [{
          userId: "peer-existing",
          name: "Existing",
          discriminator: "0002",
          avatar: "E",
          avatarVersion: 2,
        }, {
          userId: "peer-new",
          name: "New",
          discriminator: "0003",
          avatar: "N",
          avatarVersion: 1,
        }],
        messages: [],
      },
    })

    await vi.waitFor(() => {
      expect(db.collections.channels.get("existing")).toMatchObject({
        position: 7,
        muted: true,
        preview: "keep preview",
        lastMessageAt: "2026-09-28T00:00:07.000Z",
        lastUnreadSeq: 7,
      })
      expect(db.collections.channels.get("new")).toMatchObject({
        position: 1,
        muted: false,
        preview: "",
        lastMessageAt: "2026-09-28T00:00:08.000Z",
        lastUnreadSeq: 8,
      })
    })
  })

  it("updates every affected scope when attention items are removed", async () => {
    const db = await registry()
    const scope = (
      scopeId: string,
      ordinaryUnread: boolean,
      attentionCount: number,
    ) => ({
      scopeId,
      channelId: scopeId,
      serverId: "s1",
      parentChannelId: null,
      ordinaryUnread,
      lastUnreadSeq: 9,
      lastAttentionSeq: 9,
      attentionCount,
    })
    const attentionItem = (scopeId: string, sourceId: string, kind: "mention" | "reply") => ({
      id: `${kind}:${sourceId}`,
      kind,
      sourceId,
      scopeId,
      messageId: `message:${sourceId}`,
      actorUserId: "actor",
      createdAt: "2026-09-28T00:00:09.000Z",
    })
    const snapshot = {
      scopes: [
        scope("multiple", false, 2),
        scope("attention-only", false, 1),
        scope("ordinary", true, 1),
      ],
      items: [
        attentionItem("multiple", "remove", "mention"),
        attentionItem("multiple", "keep", "reply"),
        attentionItem("attention-only", "final", "mention"),
        attentionItem("ordinary", "ordinary-final", "reply"),
      ],
      limit: 100,
      truncated: false,
    }
    ingestAttentionSnapshot(db, snapshot)

    removeAttentionItemsOptimistically(
      db,
      (entry) => entry.sourceId !== "keep",
    )
    const token = captureCommunityLiveSnapshotToken(db.queryClient)
    expect(publishAccountAttentionSnapshot(db.queryClient, {
      snapshot,
      proof: { token, signal: undefined },
    })).toBe("published")

    await vi.waitFor(() => {
      expect(db.collections.attentionScopes.get("multiple")).toMatchObject({
        attentionCount: 1,
        lastAttentionSeq: 9,
      })
      expect(db.collections.attentionItems.get("reply:keep")).toBeDefined()
      expect(db.collections.attentionScopes.get("attention-only")).toBeUndefined()
      expect(db.collections.attentionScopes.get("ordinary")).toMatchObject({
        ordinaryUnread: true,
        attentionCount: 0,
        lastAttentionSeq: null,
      })
    })
  })

  it("does not roll back an optimistic clear started before or during a snapshot GET", async () => {
    const db = await registry()
    const scope = {
      scopeId: "c1",
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
      lastAttentionSeq: 4,
      attentionCount: 1,
    }
    ingestAttentionSnapshot(db, { scopes: [scope], items: [], limit: 100, truncated: false })

    const before = clearAttentionOptimistically(db)
    const beforeToken = captureCommunityLiveSnapshotToken(db.queryClient)
    publishAccountAttentionSnapshot(db.queryClient, {
      snapshot: { scopes: [scope], items: [], limit: 100, truncated: false },
      proof: { token: beforeToken, signal: undefined },
    })
    expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
    commitAttentionOptimisticSnapshot(db, before)

    ingestAttentionSnapshot(db, { scopes: [scope], items: [], limit: 100, truncated: false })
    const duringToken = captureCommunityLiveSnapshotToken(db.queryClient)
    const during = clearAttentionOptimistically(db)
    publishAccountAttentionSnapshot(db.queryClient, {
      snapshot: { scopes: [scope], items: [], limit: 100, truncated: false },
      proof: { token: duringToken, signal: undefined },
    })
    expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
    commitAttentionOptimisticSnapshot(db, during)
  })

  it("keeps a higher-seq scope and item through a target-seq attention reconcile", async () => {
    const db = await registry()
    ingestMessages(db, "c1", [
      {
        id: "m4",
        type: "chat",
        authorId: "u2",
        seq: 4,
        createdAt: "2026-09-27T01:00:00.000Z",
      },
      {
        id: "m5",
        type: "chat",
        authorId: "u2",
        seq: 5,
        createdAt: "2026-09-27T01:01:00.000Z",
      },
    ])
    const oldItem = {
      id: "mention:old",
      kind: "mention" as const,
      sourceId: "old",
      scopeId: "c1",
      messageId: "m4",
      actorUserId: "u2",
      createdAt: "2026-09-27T01:00:00.000Z",
    }
    const newItem = {
      id: "mention:new",
      kind: "mention" as const,
      sourceId: "new",
      scopeId: "c1",
      messageId: "m5",
      actorUserId: "u2",
      createdAt: "2026-09-27T01:01:00.000Z",
    }
    const oldScope = {
      scopeId: "c1",
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
      lastAttentionSeq: 4,
      attentionCount: 1,
    }
    ingestAttentionSnapshot(db, {
      scopes: [{
        ...oldScope,
        lastUnreadSeq: 5,
        lastAttentionSeq: 5,
        attentionCount: 2,
      }],
      items: [newItem, oldItem],
      limit: 100,
      truncated: false,
    })
    expect(db.collections.messages.get("m5")?.seq).toBe(5)
    expect(db.collections.attentionScopes.get("c1")?.lastUnreadSeq).toBe(5)
    const optimistic = clearAttentionScopeOptimistically(db, "c1", 4)
    expect(db.collections.attentionScopes.get("c1")).toMatchObject({
      lastUnreadSeq: 5,
      lastAttentionSeq: 5,
      attentionCount: 1,
    })
    expect(db.collections.attentionItems.get(oldItem.id)).toBeUndefined()
    expect(db.collections.attentionItems.get(newItem.id)).toMatchObject(newItem)

    ingestAttentionSnapshot(db, {
      scopes: [{
        ...oldScope,
        lastUnreadSeq: 5,
        lastAttentionSeq: 5,
        attentionCount: 2,
      }],
      items: [newItem, oldItem],
      limit: 100,
      truncated: false,
    })
    commitAttentionScopeOptimisticSnapshot(db, optimistic)

    expect(db.collections.attentionScopes.get("c1")).toMatchObject({
      lastUnreadSeq: 5,
      lastAttentionSeq: 5,
      attentionCount: 1,
    })
    expect(db.collections.attentionItems.get(oldItem.id)).toBeUndefined()
    expect(db.collections.attentionItems.get(newItem.id)).toMatchObject(newItem)
  })

  it.each(["success", "failure"] as const)(
    "uses the exact aggregate baseline for a truncated target-seq %s",
    async (terminal) => {
      const db = await registry()
      ingestMessages(db, "c1", [{
        id: "m4",
        type: "chat",
        authorId: "u2",
        seq: 4,
        createdAt: "2026-09-27T01:00:00.000Z",
      }, {
        id: "m5",
        type: "chat",
        authorId: "u2",
        seq: 5,
        createdAt: "2026-09-27T01:01:00.000Z",
      }, {
        id: "m6",
        type: "chat",
        authorId: "u2",
        seq: 6,
        createdAt: "2026-09-27T01:02:00.000Z",
      }])
      const newItem = {
        id: "mention:new",
        kind: "mention" as const,
        sourceId: "new",
        scopeId: "c1",
        messageId: "m5",
        actorUserId: "u2",
        createdAt: "2026-09-27T01:01:00.000Z",
      }
      const truncatedSnapshot = {
        scopes: [{
          scopeId: "c1",
          channelId: "c1",
          serverId: "s1",
          parentChannelId: null,
          ordinaryUnread: true,
          lastUnreadSeq: 5,
          lastAttentionSeq: 5,
          attentionCount: 151,
        }],
        items: [newItem],
        limit: 100,
        truncated: true,
      }
      ingestAttentionSnapshot(db, truncatedSnapshot)

      const optimistic = clearAttentionScopeOptimistically(db, "c1", 4)
      expect(optimistic.clearedAttentionCount).toBe(150)
      expect(db.collections.attentionScopes.get("c1")).toMatchObject({
        lastUnreadSeq: 5,
        lastAttentionSeq: 5,
        attentionCount: 1,
      })
      expect(db.collections.attentionItems.get(newItem.id)).toMatchObject(newItem)
      if (terminal === "success") {
        ingestAttentionSnapshot(db, truncatedSnapshot)
        commitAttentionScopeOptimisticSnapshot(db, optimistic)
        expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(1)
      } else {
        const newerSnapshot = {
          scopes: [{
            ...truncatedSnapshot.scopes[0]!,
            lastUnreadSeq: 6,
            lastAttentionSeq: 6,
            attentionCount: 2,
          }],
          items: [newItem, {
            id: "mention:m6",
            kind: "mention" as const,
            sourceId: "m6",
            scopeId: "c1",
            messageId: "m6",
            actorUserId: "u2",
            createdAt: "2026-09-27T01:02:00.000Z",
          }],
          limit: 100,
          truncated: true,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        }
        const reconcileToken = captureCommunityLiveSnapshotToken(db.queryClient)
        publishAccountAttentionSnapshot(db.queryClient, {
          snapshot: newerSnapshot,
          proof: { token: reconcileToken },
        })
        expect(restoreAttentionScopeOptimisticSnapshot(db, optimistic)).toBe(true)
        ingestAttentionSnapshot(db, newerSnapshot)
        expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(2)
        expect(db.collections.attentionItems.get("mention:m6")).toMatchObject({
          messageId: "m6",
        })
      }
      expect(db.collections.attentionItems.get(newItem.id)).toMatchObject(newItem)
    },
  )

  it("retires a completed attention transaction before a simultaneous canonical rebase", async () => {
    const db = await registry()
    const snapshot = {
      scopes: ["c1", "c2"].map((scopeId) => ({ scopeId, channelId: scopeId, serverId: "s1", parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 5, lastAttentionSeq: null, attentionCount: 0 })),
      items: [], limit: 100, truncated: false,
    }
    ingestAttentionSnapshot(db, snapshot)
    const nativeCreate = db.dbClient.createTransaction.bind(db.dbClient)
    const transactions: Array<ReturnType<typeof nativeCreate>> = []
    vi.spyOn(db.dbClient, "createTransaction").mockImplementation((options) => {
      const transaction = nativeCreate(options)
      transactions.push(transaction)
      return transaction
    })
    const first = clearAttentionScopeOptimistically(db, "c1", 5)
    const second = clearAttentionScopeOptimistically(db, "c2", 5)
    const transaction = transactions.at(-2)!
    const nativeSetState = transaction.setState.bind(transaction)
    let rebased = false
    vi.spyOn(transaction, "setState").mockImplementation((state) => {
      nativeSetState(state)
      if (state === "completed" && !rebased) {
        rebased = true
        ingestAttentionSnapshot(db, { ...snapshot, scopes: [] })
      }
    })
    await expect(Promise.all([commitAttentionScopeOptimisticSnapshot(db, first), commitAttentionScopeOptimisticSnapshot(db, second)])).resolves.toEqual([true, true])
    expect(rebased).toBe(true)
    expect(db.collections.attentionScopes.size).toBe(0)
    expect(db.collections.attentionItems.size).toBe(0)
  })

  it.each(["older-first", "newer-first", "rollback-older", "rollback-both"] as const)(
    "does not double-subtract nested scope fences when %s settles",
    async (settledFirst) => {
      const db = await registry()
      ingestMessages(db, "c1", [{
        id: "m4",
        type: "chat",
        authorId: "u2",
        seq: 4,
      }, {
        id: "m5",
        type: "chat",
        authorId: "u2",
        seq: 5,
      }])
      const items = [4, 5].map((seq) => ({
        id: `mention:${seq}`,
        kind: "mention" as const,
        sourceId: String(seq),
        scopeId: "c1",
        messageId: `m${seq}`,
        actorUserId: "u2",
        createdAt: `2026-09-27T01:0${seq}:00.000Z`,
      }))
      const snapshot = {
        scopes: [{
          scopeId: "c1",
          channelId: "c1",
          serverId: "s1",
          parentChannelId: null,
          ordinaryUnread: true,
          lastUnreadSeq: 5,
          lastAttentionSeq: 5,
          attentionCount: 2,
        }],
        items,
        limit: 100,
        truncated: false,
      }
      ingestAttentionSnapshot(db, snapshot)
      const older = clearAttentionScopeOptimistically(db, "c1", 4)
      const newer = clearAttentionScopeOptimistically(db, "c1", 5)

      ingestAttentionSnapshot(db, snapshot)
      expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
      if (settledFirst === "older-first") {
        commitAttentionScopeOptimisticSnapshot(db, older)
        expect(restoreAttentionScopeOptimisticSnapshot(db, newer)).toBe(true)
        expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(1)
        expect(db.collections.attentionItems.get("mention:4")).toBeUndefined()
        expect(db.collections.attentionItems.get("mention:5")).toBeDefined()
      } else if (settledFirst === "newer-first") {
        commitAttentionScopeOptimisticSnapshot(db, newer)
        expect(restoreAttentionScopeOptimisticSnapshot(db, older)).toBe(false)
        expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
      } else {
        expect(restoreAttentionScopeOptimisticSnapshot(db, older)).toBe(false)
        ingestAttentionSnapshot(db, snapshot)
        expect(db.collections.attentionScopes.get("c1")).toBeUndefined()
        if (settledFirst === "rollback-older") {
          commitAttentionScopeOptimisticSnapshot(db, newer)
        } else {
          expect(restoreAttentionScopeOptimisticSnapshot(db, newer)).toBe(true)
          expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(2)
          expect(db.collections.attentionItems.get("mention:4")).toBeDefined()
          expect(db.collections.attentionItems.get("mention:5")).toBeDefined()
          ingestAttentionSnapshot(db, snapshot)
          expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(2)
        }
      }
    },
  )

  it("merges a committed fence into the newest of multiple successors", async () => {
    const db = await registry()
    ingestMessages(db, "c1", [4, 5, 6].map((seq) => ({
      id: `m${seq}`,
      type: "chat" as const,
      authorId: "u2",
      seq,
    })))
    const items = [4, 5, 6].map((seq) => ({
      id: `mention:${seq}`,
      kind: "mention" as const,
      sourceId: String(seq),
      scopeId: "c1",
      messageId: `m${seq}`,
      actorUserId: "u2",
      createdAt: `2026-09-27T01:0${seq}:00.000Z`,
    }))
    const reconcileToken = captureCommunityLiveSnapshotToken(db.queryClient)
    publishAccountAttentionSnapshot(db.queryClient, { snapshot: {
      scopes: [{
        scopeId: "c1",
        channelId: "c1",
        serverId: "s1",
        parentChannelId: null,
        ordinaryUnread: true,
        lastUnreadSeq: 6,
        lastAttentionSeq: 6,
        attentionCount: 3,
      }],
      items,
      limit: 100,
      truncated: false,
      included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
    }, proof: { token: reconcileToken } })
    const oldest = clearAttentionScopeOptimistically(db, "c1", 4)
    const middle = clearAttentionScopeOptimistically(db, "c1", 5)
    const newest = clearAttentionScopeOptimistically(db, "c1", 6)

    commitAttentionScopeOptimisticSnapshot(db, oldest)
    commitAttentionScopeOptimisticSnapshot(db, middle)
    expect(restoreAttentionScopeOptimisticSnapshot(db, newest)).toBe(true)
    expect(db.collections.attentionScopes.get("c1")?.attentionCount).toBe(1)
    expect(db.collections.attentionItems.get("mention:6")).toBeDefined()
  })

  it("preserves a higher-seq authoritative scope and item when an older optimistic read fails", async () => {
    const db = await registry()
    ingestMessages(db, "c1", [{
      id: "m5",
      type: "chat",
      authorId: "u2",
      seq: 5,
      createdAt: "2026-09-27T01:01:00.000Z",
    }])
    ingestAttentionSnapshot(db, {
      scopes: [{
        scopeId: "c1",
        channelId: "c1",
        serverId: "s1",
        parentChannelId: null,
        ordinaryUnread: true,
        lastUnreadSeq: 4,
        lastAttentionSeq: 4,
        attentionCount: 1,
      }],
      items: [{
        id: "mention:old",
        kind: "mention",
        sourceId: "old",
        scopeId: "c1",
        messageId: "m4",
        actorUserId: "u2",
        createdAt: "2026-09-27T01:00:00.000Z",
      }],
      limit: 100,
      truncated: false,
    })
    const optimistic = clearAttentionScopeOptimistically(db, "c1", 4)
    const newerSnapshot = {
      scopes: [{
        scopeId: "c1",
        channelId: "c1",
        serverId: "s1",
        parentChannelId: null,
        ordinaryUnread: true,
        lastUnreadSeq: 5,
        lastAttentionSeq: 5,
        attentionCount: 1,
      }],
      items: [{
        id: "mention:m5",
        kind: "mention",
        sourceId: "m5",
        scopeId: "c1",
        messageId: "m5",
        actorUserId: "u2",
        createdAt: "2026-09-27T01:01:00.000Z",
      }],
      limit: 100,
      truncated: false,
    }
    ingestAttentionSnapshot(db, newerSnapshot)

    expect(restoreAttentionScopeOptimisticSnapshot(db, optimistic)).toBe(true)
    ingestAttentionSnapshot(db, newerSnapshot)
    expect(db.collections.attentionScopes.get("c1")).toMatchObject({
      lastUnreadSeq: 5,
      lastAttentionSeq: 5,
      attentionCount: 1,
    })
    expect(db.collections.attentionItems.get("mention:m5")).toMatchObject({
      messageId: "m5",
    })
    expect(db.collections.attentionItems.get("mention:old")).toBeUndefined()
  })

  it("merges partial attention hydration without erasing richer profile or message fields", async () => {
    const db = await registry()
    writeCommunityProfilePatches([{
      id: "u2",
      identityAbout: {
        name: "Alice",
        discriminator: "0002",
        aboutMe: "rich bio",
        ownerUserId: "owner",
      },
      avatar: { avatar: "rich.png", avatarVersion: 2 },
      status: { statusEmoji: "🌿", statusText: "Shipping" },
    }], db)
    ingestMessages(db, "c1", [{
      id: "m1",
      channelId: "c1",
      type: "chat",
      authorId: "u2",
      authorName: "Alice",
      content: "rich",
      attachments: [{ id: "a1", name: "proof.png" }],
      replyTo: { id: "m0", authorId: "u3", authorName: "Bob", content: "earlier" },
    }])

    ingestAttentionSnapshot(db, {
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: {
        profiles: [{
          userId: "u2",
          name: "Alice Updated",
          discriminator: "0002",
          avatar: "base.png",
          avatarVersion: 2,
        }],
        messages: [{
          id: "m1",
          channelId: "c1",
          type: "chat",
          authorId: "u2",
          content: "new preview",
        }],
      },
    })

    expect(db.collections.profiles.get("u2")).toMatchObject({
      name: "Alice Updated",
      aboutMe: "rich bio",
      ownerUserId: "owner",
      statusEmoji: "🌿",
      statusText: "Shipping",
    })
    expect(db.collections.messages.get("m1")).toMatchObject({
      content: "new preview",
      attachments: [{ id: "a1", name: "proof.png" }],
      replyTo: { id: "m0", authorId: "u3" },
    })
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

  it("purges a scoped raw single-message query before it materializes canonically", async () => {
    const db = await registry()
    rememberMessageAccessScope(db.queryClient, "cold-opener", {
      channelId: "detail-not-loaded",
      serverId: "s1",
    })
    db.queryClient.setQueryData(communityKeys.message("cold-opener"), {
      id: "cold-opener",
      type: "chat",
      authorId: "peer",
      authorName: "Peer",
      authorAvatar: "P",
      authorAvatarVersion: 0,
      content: "raw only",
      createdAt: "2026-09-25T00:00:00.000Z",
    })

    expect(db.collections.messages.get("cold-opener")).toBeUndefined()
    purgeCommunityServer(db, "s1")

    expect(db.queryClient.getQueryState(communityKeys.message("cold-opener"))).toBeUndefined()
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

  it("purges durable rows and transient owners for channel and server scopes", async () => {
    const db = await registry()
    const navigationMemory = new Map<string, string>()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => navigationMemory.get(key) ?? null,
      setItem: (key: string, value: string) => navigationMemory.set(key, value),
      removeItem: (key: string) => navigationMemory.delete(key),
    })
    const uninstall = installCommunityDbSync(db.queryClient, db)
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "owner",
      categories: [{
        id: "cat1", name: "General",
        channels: [
          { id: "c1", name: "one", active: false, unread: false },
          { id: "c2", name: "two", active: false, unread: false },
        ],
      }],
    })
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.child_create", parentChannelId: "c1", parentMessageId: "opener",
      channel: { id: "thread1", name: "Thread", type: "thread", createdAt: "2026-09-25T00:00:00.000Z" },
    } as CommunityWsEvent)
    ingestMessages(db, "c1", [{
      id: "m1", type: "chat", authorId: "author", authorName: "Author", content: "rich",
      createdAt: "2026-09-25T00:00:00.000Z",
      replyTo: { id: "reply", authorId: "reply-author", authorName: "Reply", text: "reply" },
      thread: {
        id: "thread1", name: "Thread", messageCount: 1,
        participants: [{ id: "participant", name: "Participant", avatar: "P", avatarVersion: 1 }],
      },
      approval: {
        status: "pending",
        otherProfile: { id: "approval", name: "Approval", discriminator: "0004", image: null, avatarVersion: 1 },
      },
    }])
    ingestReadStateSnapshot(db, {
      revision: 1,
      readStates: [{
        channelId: "c1", lastReadMessageId: "m1",
        lastReadAt: "2026-09-25T00:00:01.000Z", lastReadSeq: 1,
      }],
    })
    db.queryClient.setQueryData(communityKeys.folders(), {
      folders: [{ id: "f1", name: "Folder", position: 0, servers: [{ id: "s1", name: "Server", initial: "S", icon: null }] }],
    })
    db.queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [
        { serverId: "s1", level: "all" },
        { channelId: "c1", level: "mentions" },
      ],
      server: {}, channel: {},
    })
    db.queryClient.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [],
      servers: [{
        serverId: "s1",
        channels: [
          { channelId: "c1", children: [{ channelId: "thread1" }] },
          { channelId: "c2", children: [] },
          { channelId: "stale-server-child", children: [] },
        ],
      }],
      dms: [],
    })
    db.queryClient.setQueryData(communityKeys.messageContext("channel", "c1", 1), {
      messages: [],
    })
    setLastChannel("s1", "c1")
    db.runtime.ui.setState((state) => ({ ...state, ...{
      currentServerId: "s1",
      currentChannelId: "c1",
      typingByScope: new Map([
        ["ch:c1", new Map([["author", "Author"]])],
        ["dm:c1", new Map([["author", "Author"]])],
      ]),
      subscription: { channelId: "c1", secondaryChannelId: "thread1", dmConversationId: "c1" },
      secondaryChannelOwner: Symbol("test"),
      pendingReply: { channelId: "c1", target: { id: "m1", authorName: "Author", text: "rich" } },
    } }))
    db.runtime.messageStream.setState((state) => ({ ...state, ...{
      entries: new Map([["channel:c1", {
        scope: { kind: "channel", id: "c1", serverId: "s1" },
        state: { liveIds: [], outboxByNonce: new Map() },
      }]]),
    } }))

    purgeCommunityChannel(db, "thread1")
    expect(db.queryClient.getQueryData<{ servers: Array<{ channels: Array<{ children: unknown[] }> }> }>(
      communityKeys.inboxUnreads(),
    )?.servers[0]?.channels[0]?.children).toEqual([])
    purgeCommunityServer(db, "s1")

    expect(db.collections.readStates.get("c1")).toBeUndefined()
    expect(db.collections.folderItems.get("f1:s1")).toBeUndefined()
    expect(db.collections.notificationSettings.size).toBe(0)
    expect(db.runtime.ui.get()).toMatchObject({
      currentServerId: null,
      currentChannelId: null,
      subscription: {},
      pendingReply: null,
    })
    expect(db.runtime.messageStream.get().entries.size).toBe(0)
    uninstall()
    db.runtime.ui.actions.reset()
    db.runtime.messageStream.actions.resetAll()
  })

  it("keeps writes safe across idle collections, anonymous DMs, and absent registries", async () => {
    const idleClient = new QueryClient()
    const idle = createCommunityDbRegistry(idleClient, "viewer")
    ingestServers(idle, { servers: [{
      id: "idle", name: "Idle", initial: "I", active: false, unread: false,
      mentions: 0, ownerId: "viewer",
    }] })
    expect(idleClient.getQueryData(communityKeys.communityDbCollection("viewer", "servers"))).toBeDefined()
    await idle["cleanup"]()

    const anonymous = createCommunityDbRegistry(new QueryClient(), null)
    await anonymous.preload()
    ingestDms(anonymous, { conversations: [{
      id: "dm", userId: "peer", name: "Peer", discriminator: "0001",
      avatar: "P", avatarVersion: 1, status: "offline", preview: "",
    }] })
    expect(anonymous.collections.channels.size).toBe(0)
    await anonymous["cleanup"]()

    projectCommunityWsEventToDb(new QueryClient(), {
      type: "community:message.edited", channelId: "missing", messageId: "missing", content: "noop",
    } as CommunityWsEvent)
  })

  it("leaves channel membership projection to the type-resolved handler", async () => {
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
      type: "community:channel.member_add",
      serverId: "s1",
      channelId: "thread1",
      userId: "viewer",
    } as CommunityWsEvent)

    expect(db.collections.channelMemberships.get("thread1:viewer:notify")).toBeUndefined()
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.member_remove",
      serverId: "s1",
      channelId: "thread1",
      userId: "viewer",
    } as CommunityWsEvent)

    expect(db.collections.channelMemberships.get("thread1:viewer:notify")).toBeUndefined()
    expect(db.collections.channels.get("thread1")).toBeDefined()
    expect(db.collections.channels.get("c1")).toBeDefined()

    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:channel.member_remove",
      serverId: "s1",
      channelId: "c1",
      userId: "viewer",
    } as CommunityWsEvent)
    expect(db.collections.channels.get("c1")).toBeDefined()
    expect(db.collections.channels.get("thread1")).toBeDefined()
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

  it("normalizes raw websocket attachments once at canonical DB ingress", async () => {
    const db = await registry()
    projectCommunityWsEventToDb(db.queryClient, {
      type: "community:message.create",
      channelId: "c1",
      serverId: "s1",
      message: {
        id: "m-attachment",
        seq: 1,
        type: "chat",
        authorId: "peer",
        authorName: "Peer",
        authorAvatarVersion: 0,
        content: "files",
        createdAt: "2026-09-25T00:00:01.000Z",
        attachments: [
          {
            id: "image",
            filename: "photo.png",
            url: "/photo.png",
            contentType: "image/png",
            size: 2_048,
            width: null,
            height: 480,
          },
          {
            id: "file",
            filename: "notes.txt",
            url: "/notes.txt",
          },
        ],
      },
    } as CommunityWsEvent)

    expect(db.collections.messages.get("m-attachment")?.attachments).toEqual([
      {
        kind: "image",
        name: "photo.png",
        url: "/photo.png",
        contentType: "image/png",
        sizeBytes: 2_048,
        width: undefined,
        height: 480,
      },
      {
        kind: "file",
        name: "notes.txt",
        url: "/notes.txt",
        contentType: undefined,
        sizeBytes: undefined,
        size: "",
      },
    ])
  })

  it("projects every canonical websocket delta family", async () => {
    const db = await registry()
    ingestServers(db, { servers: [{
      id: "s1", name: "Server", initial: "S", active: false, unread: false,
      mentions: 0, ownerId: "viewer",
    }] })
    ingestServerDetail(db, {
      id: "s1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer",
      categories: [{
        id: "cat1", name: "General",
        channels: [
          { id: "c1", name: "one", active: false, unread: false },
          { id: "c2", name: "two", active: false, unread: false },
        ],
      }],
    })
    ingestMessages(db, "c1", [{
      id: "m1", type: "chat", authorId: "peer", authorName: "Peer", content: "old",
      createdAt: "2026-09-25T00:00:00.000Z",
      reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }],
    }])
    const event = (value: object) => projectCommunityWsEventToDb(
      db.queryClient,
      value as CommunityWsEvent,
    )

    event({ type: "community:channel.update", serverId: "s1", channelId: "missing", changes: { name: "noop" } })
    event({
      type: "community:channel.child_create", parentChannelId: "c1", parentMessageId: null,
      channel: { id: "missing-opener", name: "Missing", type: "thread", createdAt: "2026-09-25T00:00:00.000Z" },
    })
    event({
      type: "community:channel.child_create", parentChannelId: "missing", parentMessageId: "m1",
      channel: { id: "missing-parent", name: "Missing", type: "thread", createdAt: "2026-09-25T00:00:00.000Z" },
    })
    event({ type: "community:unread.bump", serverId: "s1", channelId: "c1", userId: "other", isMention: true })
    event({ type: "community:message.updated", channelId: "c1", messageId: "m1", approval: { status: "pending" } })
    event({ type: "community:reaction.add", channelId: "c1", messageId: "m1", userId: "viewer", emoji: "👍" })
    event({ type: "community:reaction.remove", channelId: "c1", messageId: "m1", userId: "peer", emoji: "👍" })
    event({ type: "community:server.update", serverId: "s1", changes: { name: "Renamed" } })
    event({ type: "community:channel.update", serverId: "s1", channelId: "c1", changes: { name: "renamed" } })
    event({ type: "community:channel.reorder", serverId: "s1", channels: [{ id: "c1", position: 9 }] })
    event({ type: "community:category.create", serverId: "s1", category: { id: "cat2", name: "Other", position: 2, private: false } })
    event({ type: "community:category.update", serverId: "s1", categoryId: "cat2", changes: { name: "Updated" } })
    event({ type: "community:category.reorder", serverId: "s1", categories: [{ id: "cat2", position: 0 }] })
    event({
      type: "community:member.join", serverId: "s1",
      member: {
        id: "member-peer", userId: "peer", role: "member",
        joinedAt: "2026-09-25T00:00:00.000Z", name: "Peer", discriminator: "0002",
        avatar: "P", avatarVersion: 1,
      },
    })
    event({
      type: "community:member.update", serverId: "s1", memberId: "member-peer",
      userId: "peer", changes: { role: "admin" },
    })
    event({ type: "community:channel.member_add", serverId: "s1", channelId: "c1", userId: "peer" })
    event({ type: "community:channel.member_remove", serverId: "s1", channelId: "c1", userId: "peer" })
    event({ type: "community:unread.bump", serverId: "s1", channelId: "c1", railChannelId: "c2", userId: "viewer", isMention: true })
    event({
      type: "community:profile.update", userId: "peer", name: "Peer Two",
      discriminator: "0003", aboutMe: "hello", bannerColor: "#fff", kind: "human",
      ownerUserId: null,
    })
    event({
      type: "community:channel.child_create", parentChannelId: "c1", parentMessageId: "m1",
      channel: { id: "thread1", name: "Thread", type: "thread", createdAt: "2026-09-25T00:00:01.000Z" },
    })
    event({
      type: "community:channel.child_update", channelId: "thread1",
      changes: { name: "Thread renamed", archived: false, tags: ["tag"], lastMessageAt: "2026-09-25T00:00:02.000Z" },
    })
    event({ type: "community:member.leave", serverId: "s1", userId: "peer" })
    event({ type: "community:category.delete", serverId: "s1", categoryId: "cat2" })

    expect(db.collections.servers.get("s1")).toMatchObject({ name: "Renamed", unread: true, mentions: 1 })
    expect(db.collections.channels.get("c1")).toMatchObject({ name: "renamed", position: 9, unread: true })
    expect(db.collections.channels.get("thread1")).toMatchObject({ name: "Thread renamed", tags: ["tag"] })
    expect(db.collections.messages.get("m1")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["viewer"] },
    ])
    expect(db.collections.serverMemberships.get("s1:peer")).toBeUndefined()
    expect(db.collections.profiles.get("peer")).toMatchObject({ name: "Peer Two", aboutMe: "hello" })

    event({
      type: "community:channel.child_update", channelId: "thread1",
      changes: { archived: true },
    })
    expect(db.collections.channels.get("thread1")).toMatchObject({ archived: true })
    event({ type: "community:channel.delete", serverId: "s1", channelId: "c2" })
    expect(db.collections.channels.get("c2")).toBeUndefined()
    event({ type: "community:server.delete", serverId: "s1" })
    expect(db.collections.servers.get("s1")).toBeUndefined()
    ingestServers(db, { servers: [{
      id: "leave", name: "Leave", initial: "L", active: false, unread: false,
      mentions: 0, ownerId: "viewer",
    }] })
    event({ type: "community:member.leave", serverId: "leave", userId: "viewer" })
    expect(db.collections.servers.get("leave")).toBeUndefined()
    event({ type: "community:unknown" })
  })

  it("ignores raw message-bearing surfaces while canonical rows still accept WS deltas", async () => {
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
    db.queryClient.setQueryData(communityKeys.inboxMentions(), {})
    db.queryClient.setQueryData(communityKeys.inboxMarked(), {})
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

    expect([...db.collections.messages.keys()]).toEqual([])
    ingestMessages(db, "c1", [message("pin", "pin")])
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
    db.queryClient.setQueryData(communityKeys.message("pin"), message("pin", "stale"))
    purgeCommunityChannel(db, "c1")
    expect(db.collections.messages.size).toBe(0)
    expect(db.queryClient.getQueryState(communityKeys.message("pin"))).toBeUndefined()
    uninstall()
  })

  it("does not infer a cold opener from raw Query but accepts explicit canonical publication", async () => {
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

    expect(db.collections.messages.get("opener")).toBeUndefined()
    ingestMessages(db, "forum1", [{
      id: "opener",
      type: "chat",
      authorId: "peer",
      authorName: "Peer",
      authorAvatar: "P",
      authorAvatarVersion: 0,
      content: "cold opener",
      createdAt: "2026-09-25T00:00:00.000Z",
    }])
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


describe("forum archive channel semantics", () => {
  it("keeps opener archive tags separate when publishing embedded thread previews", async () => {
    const db = await registry()
    const message = { id: "opener", type: "chat" as const, content: "Post", thread: { id: "post", name: "Post", messageCount: 1, tags: ["archived"], participants: [] } }
    ingestMessages(db, "forum", [message])
    expect(db.collections.channels.get("post")).toMatchObject({ archived: false, tags: ["archived"] })
    db.collections.channels.utils.writeUpsert([{ ...db.collections.channels.get("post")!, archived: true }])
    ingestMessages(db, "forum", [{ ...message, thread: { ...message.thread, tags: [] } }])
    expect(db.collections.channels.get("post")).toMatchObject({ archived: true, tags: [] })
  })
})

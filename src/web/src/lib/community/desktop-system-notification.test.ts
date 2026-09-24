import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommunityMessageCreate, CommunityWsEvent } from "@alook/shared"
import { QueryClient } from "@tanstack/react-query"
import type { StructuralSnapshotV1 } from "./structural-snapshot"
import {
  buildDesktopSystemNotificationCandidate,
  listenDesktopSystemNotificationActivations,
  resolveDesktopSystemNotificationCandidate,
  showDesktopSystemNotification,
  takeDesktopSystemNotificationActivation,
} from "./desktop-system-notification"

const invoke = vi.hoisted(() => vi.fn())
const desktopMode = vi.hoisted(() => ({ value: true }))
const channelMetadataMocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, isDesktop: vi.fn(() => desktopMode.value), tauriInvoke: invoke }
})
vi.mock("@/hooks/community/channel-metadata", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/community/channel-metadata")>(
    "@/hooks/community/channel-metadata",
  )
  return { ...actual, fetchChannelMetadata: channelMetadataMocks.fetch }
})

type UnreadBump = Extract<CommunityWsEvent, { type: "community:unread.bump" }>
const create: CommunityMessageCreate = {
  type: "community:message.create",
  channelId: "channel_1",
  serverId: "server_1",
  message: {
    id: "message_1",
    seq: 7,
    authorId: "author_1",
    authorName: "  Ada  ",
    authorAvatarVersion: 0,
    content: "**Hello**\n   there",
    type: "chat",
    createdAt: "2026-09-12T00:00:00.000Z",
  },
}
const bump: UnreadBump = {
  type: "community:unread.bump",
  userId: "viewer_1",
  channelId: "channel_1",
  serverId: "server_1",
}
const snapshot: StructuralSnapshotV1 = {
  schemaVersion: 1,
  accountId: "viewer_1",
  capturedAt: 1,
  serverOrder: ["server_1"],
  folders: [],
  servers: [{
    id: "server_1",
    name: "Studio",
    discriminator: "0042",
    icon: null,
    categories: [],
    channels: [{ id: "channel_1", name: "general", type: "text", categoryId: null }],
    childRouteHints: [{
      id: "thread_1",
      name: "Release notes",
      type: "thread",
      parentChannelId: "channel_1",
      parentMessageId: "message_0",
    }],
  }],
}

afterEach(() => {
  desktopMode.value = true
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("desktop system notification candidates", () => {
  it("derives a hygienic server notification from one paired bundle", () => {
    expect(buildDesktopSystemNotificationCandidate(create, bump, "viewer_1", snapshot)).toEqual({
      viewerUserId: "viewer_1",
      title: "Studio · #general",
      body: "Ada: Hello there",
      target: {
        kind: "server",
        serverId: "server_1",
        channelId: "channel_1",
        messageId: "message_1",
        seq: 7,
      },
    })
  })

  it("uses the same server, parent channel, and thread title hierarchy as mobile", () => {
    expect(buildDesktopSystemNotificationCandidate({
      ...create,
      channelId: "thread_1",
    }, { ...bump, channelId: "thread_1" }, "viewer_1", snapshot)).toMatchObject({
      title: "Studio · #general · Release notes",
      body: "Ada: Hello there",
    })
  })

  it("does not reuse conversation names from another account's snapshot", () => {
    expect(buildDesktopSystemNotificationCandidate(
      create,
      bump,
      "viewer_1",
      { ...snapshot, accountId: "other" },
    )).toMatchObject({
      title: "Server · #Channel",
      body: "Ada: Hello there",
    })
  })

  it("resolves a cold channel name before formatting the desktop copy", async () => {
    const queryClient = new QueryClient()
    channelMetadataMocks.fetch.mockResolvedValue({
      id: "channel_1",
      serverId: "server_1",
      name: "general",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
    })
    const coldSnapshot = {
      ...snapshot,
      servers: snapshot.servers.map((server) => ({
        ...server,
        channels: [],
        childRouteHints: [],
      })),
    }

    await expect(resolveDesktopSystemNotificationCandidate(
      create,
      bump,
      "viewer_1",
      queryClient,
      coldSnapshot,
    )).resolves.toMatchObject({
      title: "Studio · #general",
      body: "Ada: Hello there",
    })
    expect(channelMetadataMocks.fetch).toHaveBeenCalledWith("server_1", "channel_1")
  })

  it("resolves cold thread and parent channel names before formatting the desktop copy", async () => {
    const queryClient = new QueryClient()
    channelMetadataMocks.fetch.mockResolvedValueOnce({
      id: "thread_1",
      serverId: "server_1",
      name: "Release notes",
      type: "thread",
      parentChannelId: "channel_1",
      parentMessageId: "message_0",
      creatorId: "author_1",
      archived: false,
      lastMessageAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
    }).mockResolvedValueOnce({
      id: "channel_1",
      serverId: "server_1",
      name: "general",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
    })
    const coldSnapshot = {
      ...snapshot,
      servers: snapshot.servers.map((server) => ({
        ...server,
        channels: [],
        childRouteHints: [],
      })),
    }

    await expect(resolveDesktopSystemNotificationCandidate(
      { ...create, channelId: "thread_1" },
      { ...bump, channelId: "thread_1" },
      "viewer_1",
      queryClient,
      coldSnapshot,
    )).resolves.toMatchObject({
      title: "Studio · #general · Release notes",
      body: "Ada: Hello there",
    })
    expect(channelMetadataMocks.fetch.mock.calls).toEqual([
      ["server_1", "thread_1"],
      ["server_1", "channel_1"],
    ])
  })

  it("uses the complete current-account snapshot without metadata I/O", async () => {
    await expect(resolveDesktopSystemNotificationCandidate(
      create,
      bump,
      "viewer_1",
      new QueryClient(),
      snapshot,
    )).resolves.toMatchObject({
      title: "Studio · #general",
      body: "Ada: Hello there",
    })
    expect(channelMetadataMocks.fetch).not.toHaveBeenCalled()
  })

  it("keeps safe fallback copy when cold metadata resolution fails", async () => {
    channelMetadataMocks.fetch.mockRejectedValue(new Error("metadata unavailable"))
    await expect(resolveDesktopSystemNotificationCandidate(
      create,
      bump,
      "viewer_1",
      new QueryClient(),
      { ...snapshot, servers: snapshot.servers.map((server) => ({
        ...server,
        channels: [],
        childRouteHints: [],
      })) },
    )).resolves.toMatchObject({
      title: "Studio · #Channel",
      body: "Ada: Hello there",
    })
  })

  it("rejects account, channel, scope, and own-author mismatches", () => {
    expect(buildDesktopSystemNotificationCandidate(create, bump, null)).toBeNull()
    expect(buildDesktopSystemNotificationCandidate(create, { ...bump, userId: "other" }, "viewer_1")).toBeNull()
    expect(buildDesktopSystemNotificationCandidate(create, { ...bump, channelId: "other" }, "viewer_1")).toBeNull()
    expect(buildDesktopSystemNotificationCandidate(create, { ...bump, serverId: "other" }, "viewer_1")).toBeNull()
    expect(buildDesktopSystemNotificationCandidate({
      ...create,
      message: { ...create.message, authorId: "viewer_1" },
    }, bump, "viewer_1")).toBeNull()
  })

  it.each([
    ["image/png", "Photo"],
    ["video/mp4", "Video"],
    ["audio/mpeg", "Audio"],
    ["application/pdf", "Attachment"],
  ])("uses the %s attachment fallback", (contentType, expected) => {
    const candidate = buildDesktopSystemNotificationCandidate({
      ...create,
      message: {
        ...create.message,
        content: "",
        attachments: [{ id: "a", filename: "file", url: "/file", contentType }],
      },
    }, bump, "viewer_1")
    expect(candidate?.body).toBe(`Ada: ${expected}`)
  })

  it("uses the generic fallback and derives a DM target", () => {
    expect(buildDesktopSystemNotificationCandidate({
      ...create,
      serverId: null,
      message: {
        ...create.message,
        authorName: " ",
        content: "",
        attachments: [],
      },
    }, { ...bump, serverId: null }, "viewer_1")).toEqual({
      viewerUserId: "viewer_1",
      title: "Alook",
      body: "New message",
      target: {
        kind: "dm",
        channelId: "channel_1",
        messageId: "message_1",
        seq: 7,
      },
    })
  })

  it("invokes only the narrow desktop command", async () => {
    const candidate = buildDesktopSystemNotificationCandidate(create, bump, "viewer_1")!
    await showDesktopSystemNotification(candidate)
    expect(invoke).toHaveBeenCalledWith("desktop_system_notification_show", { candidate })
  })

  it("is a no-op outside the desktop shell", async () => {
    desktopMode.value = false
    const candidate = buildDesktopSystemNotificationCandidate(create, bump, "viewer_1")!
    await showDesktopSystemNotification(candidate)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("desktop system notification activation bridge", () => {
  it("rejects listener setup when the native channel bridge is absent", async () => {
    vi.stubGlobal("window", {})
    await expect(listenDesktopSystemNotificationActivations(vi.fn())).rejects.toThrow(
      "native_bridge_unavailable",
    )
  })

  it("registers, forwards native signals, and tolerates unlisten rejection", async () => {
    const channels: Channel[] = []
    class Channel {
      onmessage = (_value: unknown) => undefined

      constructor() {
        channels.push(this)
      }
    }
    vi.stubGlobal("window", { __TAURI__: { core: { Channel } } })
    invoke.mockResolvedValueOnce(27).mockRejectedValueOnce(new Error("already removed"))
    const ready = vi.fn()

    const stop = await listenDesktopSystemNotificationActivations(ready)
    expect(invoke).toHaveBeenCalledWith("desktop_system_notification_listen", { channel: channels[0] })
    channels[0]?.onmessage(undefined)
    expect(ready).toHaveBeenCalledOnce()

    stop()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "desktop_system_notification_unlisten",
      { registrationId: 27 },
    ))
  })

  it("takes and parses only valid native activations", async () => {
    const dmActivation = {
      notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
      target: {
        kind: "dm",
        channelId: "dm_1",
        messageId: "message_2",
        seq: 8,
      },
    }
    invoke.mockResolvedValueOnce(dmActivation)
    await expect(takeDesktopSystemNotificationActivation()).resolves.toEqual(dmActivation)

    invoke.mockResolvedValueOnce({ href: "https://evil.test" })
    await expect(takeDesktopSystemNotificationActivation()).resolves.toBeNull()
  })
})

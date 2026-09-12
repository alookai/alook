import { afterEach, describe, expect, it, vi } from "vitest"
import type { CommunityMessageCreate, CommunityWsEvent } from "@alook/shared"
import {
  buildDesktopSystemNotificationCandidate,
  showDesktopSystemNotification,
} from "./desktop-system-notification"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, isDesktop: vi.fn(() => true), tauriInvoke: invoke }
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

afterEach(() => vi.clearAllMocks())

describe("desktop system notification candidates", () => {
  it("derives a hygienic server notification from one paired bundle", () => {
    expect(buildDesktopSystemNotificationCandidate(create, bump, "viewer_1")).toEqual({
      viewerUserId: "viewer_1",
      title: "Ada",
      body: "Hello there",
      target: {
        kind: "server",
        serverId: "server_1",
        channelId: "channel_1",
        messageId: "message_1",
        seq: 7,
      },
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
    expect(candidate?.body).toBe(expected)
  })

  it("invokes only the narrow desktop command", async () => {
    const candidate = buildDesktopSystemNotificationCandidate(create, bump, "viewer_1")!
    await showDesktopSystemNotification(candidate)
    expect(invoke).toHaveBeenCalledWith("desktop_system_notification_show", { candidate })
  })
})

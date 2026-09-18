import { describe, expect, it } from "vitest"
import {
  buildPushNotificationPayload,
  deriveNotificationId,
} from "./notification-payload"

function target(overrides: Partial<{
  messageId: string
  channelId: string
  authorName: string
  content: string
  conversationKind: "dm" | "channel" | "thread"
  serverName: string | null
  channelName: string | null
  parentChannelName: string | null
  attachmentContentTypes: Array<string | null>
}> = {}) {
  return {
    messageId: "message-1",
    channelId: "channel-1",
    authorName: "Alice",
    content: "**Hello** [there](https://example.test)\nnext line",
    conversationKind: "dm" as const,
    serverName: null,
    channelName: null,
    parentChannelName: null,
    attachmentContentTypes: [],
    ...overrides,
  }
}

describe("mobile notification payload", () => {
  it("derives a stable UUID-shaped ID from the user and message", async () => {
    const first = await deriveNotificationId({ messageId: "message-1", userId: "user-1" })
    const duplicate = await deriveNotificationId({ messageId: "message-1", userId: "user-1" })
    const otherUser = await deriveNotificationId({ messageId: "message-1", userId: "user-2" })

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(duplicate).toBe(first)
    expect(otherUser).not.toBe(first)
  })

  it("uses the sender title and preview-only body for a DM", async () => {
    const payload = await buildPushNotificationPayload(target(), "user-1")

    expect(payload).toEqual({
      notificationId: payload.notificationId,
      title: "Alice",
      body: "Hello there next line",
      route: {
        notificationId: payload.notificationId,
        messageId: "message-1",
        targetId: "channel-1",
      },
    })
    expect(JSON.stringify(payload)).not.toContain("https://example.test")
  })

  it.each([
    [
      "top-level channel",
      target({
        conversationKind: "channel",
        serverName: "Studio",
        channelName: "general",
      }),
      "Studio · #general",
    ],
    [
      "text-channel thread",
      target({
        conversationKind: "thread",
        serverName: "Studio",
        channelName: "Focused work",
        parentChannelName: "general",
      }),
      "Studio · #general · Focused work",
    ],
    [
      "forum post",
      target({
        conversationKind: "thread",
        serverName: "Studio",
        channelName: "Release notes",
        parentChannelName: "announcements",
      }),
      "Studio · #announcements · Release notes",
    ],
  ])("identifies the %s conversation in the title", async (_case, input, title) => {
    const payload = await buildPushNotificationPayload(input, "user-1")

    expect(payload.title).toBe(title)
    expect(payload.body).toBe("Alice: Hello there next line")
    expect(payload.route).toEqual({
      notificationId: payload.notificationId,
      messageId: "message-1",
      targetId: "channel-1",
    })
  })

  it("uses stable non-empty display fallbacks without changing the route", async () => {
    const payload = await buildPushNotificationPayload(target({
      authorName: "   ",
      conversationKind: "thread",
      serverName: "   ",
      channelName: null,
      parentChannelName: "   ",
    }), "user-1")

    expect(payload.title).toBe("Server · #Channel · Thread")
    expect(payload.body).toBe("Alook: Hello there next line")
    expect(payload.route.targetId).toBe("channel-1")
  })

  it.each([
    [["image/png"], "Photo"],
    [["video/mp4"], "Video"],
    [["audio/mpeg"], "Audio"],
    [["application/pdf"], "Attachment"],
    [[], "New message"],
  ])("uses an attachment-type fallback for %j", async (attachmentContentTypes, expected) => {
    const payload = await buildPushNotificationPayload(target({
      content: "  ",
      attachmentContentTypes,
    }), "user-1")
    expect(payload.body).toBe(expected)
  })

  it("prefixes server attachment fallbacks with the author", async () => {
    const payload = await buildPushNotificationPayload(target({
      content: "",
      conversationKind: "channel",
      serverName: "Studio",
      channelName: "general",
      attachmentContentTypes: ["image/png"],
    }), "user-1")

    expect(payload.body).toBe("Alice: Photo")
  })

  it("caps the complete author-prefixed body without splitting surrogate pairs", async () => {
    const payload = await buildPushNotificationPayload(target({
      conversationKind: "channel",
      serverName: "Studio",
      channelName: "general",
      content: `${"x".repeat(118)}😀tail`,
    }), "user-1")
    expect(payload.body.startsWith("Alice: ")).toBe(true)
    expect(payload.body.length).toBeLessThanOrEqual(120)
    expect(payload.body).not.toContain("�")
    expect(payload.body.endsWith("…")).toBe(true)
  })
})

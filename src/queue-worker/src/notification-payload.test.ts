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
  attachmentContentTypes: Array<string | null>
}> = {}) {
  return {
    messageId: "message-1",
    channelId: "channel-1",
    authorName: "Alice",
    content: "**Hello** [there](https://example.test)\nnext line",
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

  it("emits a minimal plain-text preview and opaque route", async () => {
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

  it("caps the body without splitting surrogate pairs", async () => {
    const payload = await buildPushNotificationPayload(target({
      content: `${"x".repeat(118)}😀tail`,
    }), "user-1")
    expect(payload.body).not.toContain("�")
    expect(payload.body.endsWith("…")).toBe(true)
  })
})

import { describe, expect, it, vi } from "vitest"
import {
  desktopSystemNotificationHref,
  parseDesktopSystemNotificationActivation,
  revalidateDesktopSystemNotificationTarget,
  type DesktopSystemNotificationActivation,
} from "./system-notification-route"

const activation: DesktopSystemNotificationActivation = {
  notificationId: "4f3bb3fd-5d7f-4a26-8e0e-3ddd1154f71e",
  target: {
    kind: "server",
    serverId: "server_1",
    channelId: "channel-2",
    messageId: "message_3",
    seq: 9,
  },
}

describe("desktop system notification routes", () => {
  it("accepts only exact allowlisted activation fields", () => {
    expect(parseDesktopSystemNotificationActivation(activation)).toEqual(activation)
    expect(parseDesktopSystemNotificationActivation({ ...activation, href: "https://evil.test" })).toBeNull()
    expect(parseDesktopSystemNotificationActivation({
      ...activation,
      target: { ...activation.target, serverId: "../escape" },
    })).toBeNull()
    expect(parseDesktopSystemNotificationActivation({
      ...activation,
      target: { ...activation.target, extra: true },
    })).toBeNull()
  })

  it("derives only first-party server and DM routes", () => {
    expect(desktopSystemNotificationHref(activation.target)).toBe(
      "/c/channels/server_1/channel-2?msg=message_3",
    )
    expect(desktopSystemNotificationHref({
      kind: "dm",
      channelId: "dm_1",
      messageId: "message_4",
      seq: 12,
    })).toBe("/c/me/dm_1?seq=12")
  })

  it("revalidates the exact message through the authenticated API", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "message_3" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    await expect(revalidateDesktopSystemNotificationTarget(activation.target, fetchImpl)).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith("/api/community/messages/message_3", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    })
  })

  it("rejects deleted, revoked, malformed, and mismatched responses", async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(null, { status: 403 }),
      new Response("nope", { status: 200 }),
      new Response(JSON.stringify({ id: "other" }), { status: 200 }),
    ]) {
      await expect(revalidateDesktopSystemNotificationTarget(
        activation.target,
        vi.fn(async () => response),
      )).resolves.toBe(false)
    }
  })
})

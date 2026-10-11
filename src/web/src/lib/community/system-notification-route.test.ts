import { afterEach, describe, expect, it, vi } from "vitest"
import {
  parseDesktopSystemNotificationActivation,
  systemNotificationHref,
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

afterEach(() => vi.unstubAllGlobals())

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

  it("accepts an exact DM activation and rejects malformed or unknown targets", () => {
    const dmActivation: DesktopSystemNotificationActivation = {
      notificationId: activation.notificationId,
      target: {
        kind: "dm",
        channelId: "dm_1",
        messageId: "message_4",
        seq: 12,
      },
    }
    expect(parseDesktopSystemNotificationActivation(dmActivation)).toEqual(dmActivation)
    expect(parseDesktopSystemNotificationActivation({
      ...dmActivation,
      target: { ...dmActivation.target, extra: true },
    })).toBeNull()
    expect(parseDesktopSystemNotificationActivation({
      ...dmActivation,
      target: { ...dmActivation.target, channelId: "../escape" },
    })).toBeNull()
    expect(parseDesktopSystemNotificationActivation({
      ...dmActivation,
      target: { ...dmActivation.target, kind: "external" },
    })).toBeNull()
  })

  it("derives only first-party server and DM routes", () => {
    expect(systemNotificationHref(activation.target)).toBe(
      "/c/channels/server_1/channel-2",
    )
    expect(systemNotificationHref({
      kind: "dm",
      channelId: "dm_1",
    })).toBe("/c/me/dm_1")
  })

})

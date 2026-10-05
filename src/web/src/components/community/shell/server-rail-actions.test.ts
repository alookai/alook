import { describe, expect, it } from "vitest"
import { resolveServerRailOverlayAction } from "./server-rail-actions"

describe("resolveServerRailOverlayAction", () => {
  it.each(["settings", "invite"] as const)(
    "opens active-server %s directly without producing a navigation target",
    (overlay) => {
      expect(resolveServerRailOverlayAction({
        targetServerId: "server_1",
        activeServerId: "server_1",
        overlay,
        hasActiveOpener: true,
      })).toEqual({ kind: "open-active" })
    },
  )

  it.each(["settings", "invite"] as const)(
    "keeps the existing other-server %s URL",
    (overlay) => {
      expect(resolveServerRailOverlayAction({
        targetServerId: "server_2",
        activeServerId: "server_1",
        overlay,
        hasActiveOpener: true,
      })).toEqual({
        kind: "navigate",
        href: `/c/channels/server_2?${overlay}=1`,
      })
    },
  )

  it("falls back to the existing URL when the active layout has no direct opener", () => {
    expect(resolveServerRailOverlayAction({
      targetServerId: "server_1",
      activeServerId: "server_1",
      overlay: "settings",
      hasActiveOpener: false,
    })).toEqual({
      kind: "navigate",
      href: "/c/channels/server_1?settings=1",
    })
  })

  it.each(["settings", "invite"] as const)(
    "keeps the committed active leaf and unrelated URL state for %s",
    (overlay) => {
      expect(resolveServerRailOverlayAction({
        targetServerId: "server_1",
        activeServerId: "server_1",
        overlay,
        hasActiveOpener: false,
        publishedHref: "/c/channels/server_1/channel_1?keep=1#message_1",
      })).toEqual({
        kind: "navigate",
        href: `/c/channels/server_1/channel_1?keep=1&${overlay}=1#message_1`,
      })
    },
  )

  it("does not borrow a published leaf from another server", () => {
    expect(resolveServerRailOverlayAction({
      targetServerId: "server_1",
      activeServerId: "server_1",
      overlay: "settings",
      hasActiveOpener: false,
      publishedHref: "/c/channels/server_2/channel_2?keep=1",
    })).toEqual({ kind: "navigate", href: "/c/channels/server_1?settings=1" })
  })
})

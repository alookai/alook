import { describe, expect, it } from "vitest"
import {
  channelHref,
  communityServerId,
  removeCommunityParam,
  resolveCommunityRoute,
  resolveServerSwitchCheckpoint,
  serverModalMarkerCleanupHref,
  serverRootHref,
} from "./community-route"

describe("community route", () => {
  it.each([
    ["/c/me", "list", null],
    ["/c/me/friends", "detail", "/c/me"],
    ["/c/me/machines", "detail", "/c/me"],
    ["/c/me/dm_1", "detail", "/c/me"],
    ["/c/channels/server_1", "list", null],
    ["/c/channels/server_1/channel_1", "detail", "/c/channels/server_1"],
  ])("classifies %s", (pathname, surface, parentPath) => {
    expect(resolveCommunityRoute(pathname)).toEqual({ surface, parentPath })
  })

  it("builds top-level and child hrefs through the same flat channel builder", () => {
    expect(serverRootHref("server_1")).toBe("/c/channels/server_1")
    expect(channelHref("server_1", "channel_1")).toBe("/c/channels/server_1/channel_1")
    expect(channelHref("server_1", "child_1")).toBe("/c/channels/server_1/child_1")
  })

  it.each([
    ["/c/channels/server_1", "server_1"],
    ["/c/channels/server_1/channel_1?keep=1#message", "server_1"],
    ["/c/me", null],
    ["/not-community/channels/server_1", null],
  ])("extracts the community server identity from %s", (href, serverId) => {
    expect(communityServerId(href)).toBe(serverId)
  })

  it("keeps a cold target checkpoint through eager pathname publication", () => {
    expect(resolveServerSwitchCheckpoint({
      currentHref: "/c/channels/server_1/channel_1",
      pendingHref: "/c/channels/server_2?settings=1",
      hasExactServerDetail: false,
    })).toEqual({ targetServerId: "server_2", cold: true })
    expect(resolveServerSwitchCheckpoint({
      currentHref: "/c/channels/server_1/channel_1",
      pendingHref: "/c/channels/server_2",
      hasExactServerDetail: true,
    })).toEqual({ targetServerId: "server_2", cold: false })
    expect(resolveServerSwitchCheckpoint({
      currentHref: "/c/channels/server_2",
      pendingHref: "/c/channels/server_2",
      hasExactServerDetail: false,
    })).toEqual({ targetServerId: "server_2", cold: true })
    expect(resolveServerSwitchCheckpoint({
      currentHref: "/c/channels/server_1/channel_1",
      pendingHref: "/c/channels/server_1/channel_2#message",
      hasExactServerDetail: true,
    })).toBeNull()

    for (const pendingHref of [
      null,
      "/c/me/friends",
      "/malformed",
    ]) {
      expect(resolveServerSwitchCheckpoint({
        currentHref: "/c/channels/server_1/channel_1",
        pendingHref,
        hasExactServerDetail: false,
      })).toBeNull()
    }
    expect(resolveServerSwitchCheckpoint({
      currentHref: "/c/me/friends",
      pendingHref: "/c/channels/server_2",
      hasExactServerDetail: false,
    })).toBeNull()
  })

  it("removes one query key while preserving the rest and the hash", () => {
    expect(removeCommunityParam("/c/me/dm_1?seq=4&keep=1#x", "seq")).toBe(
      "/c/me/dm_1?keep=1#x",
    )
  })

  it.each(["settings", "invite"])(
    "consumes a mobile server-root %s marker without waiting for a channel redirect",
    (marker) => {
      expect(
        serverModalMarkerCleanupHref(
          `/c/channels/server_1?${marker}=1&keep=1`,
          {
            breakpoint: "mobile",
            hasChannel: false,
            hasServerChannels: true,
          },
        ),
      ).toBe("/c/channels/server_1?keep=1")
    },
  )

  it("defers desktop server-root marker cleanup until the channel redirect wins", () => {
    expect(
      serverModalMarkerCleanupHref("/c/channels/server_1?settings=1", {
        breakpoint: "desktop",
        hasChannel: false,
        hasServerChannels: true,
      }),
    ).toBeNull()
  })

  it("cleans desktop modal markers after reaching a channel route", () => {
    expect(
      serverModalMarkerCleanupHref(
        "/c/channels/server_1/channel_1?settings=1&invite=1",
        {
          breakpoint: "desktop",
          hasChannel: true,
          hasServerChannels: true,
        },
      ),
    ).toBe("/c/channels/server_1/channel_1")
  })
})

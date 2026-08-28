import { describe, expect, it } from "vitest"
import {
  advanceCommunityCommittedFrame,
  channelHref,
  isPublishedNonStructuralCommit,
  isStructuralFrameCommit,
  normalizeCommunityHref,
  communityServerId,
  removeCommunityParam,
  resolveCommunityCheckpointPlan,
  resolveCommunityRoute,
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

  it("normalizes query order and keeps structural scope independent from hash", () => {
    expect(normalizeCommunityHref("/c/channels/server_1/channel_1?z=2&a=1#message"))
      .toEqual({
        href: "/c/channels/server_1/channel_1?a=1&z=2",
        pathname: "/c/channels/server_1/channel_1",
        search: "a=1&z=2",
        scope: { kind: "server", serverId: "server_1" },
        surface: "detail",
        leafKey: "/c/channels/server_1/channel_1",
      })
  })

  it("keeps an unknown pending href on the committed frame", () => {
    const committedFrame = {
      ...normalizeCommunityHref("/c/channels/s1/c1"),
      revision: 4,
    }
    expect(resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: "/malformed",
      pending: true,
      targetReady: false,
    })).toEqual({
      mode: "committed",
      surface: "detail",
      targetHref: "/malformed",
      rail: { kind: "keep" },
      sidebar: { kind: "keep" },
      main: { kind: "keep" },
    })
  })

  it.each([
    ["/c/channels/s1/c1", "/c/channels/s1/c2", false, "same-scope-leaf"],
    ["/c/me/friends", "/c/me/machines", false, "same-scope-leaf"],
    ["/c/channels/s1/c1", "/c/channels/s2/c2", false, "cold-scope"],
    ["/c/channels/s1/c1", "/c/channels/s2/c2", true, "warm-scope"],
    ["/c/channels/s1/c1", "/c/me/friends", false, "cold-scope"],
    ["/c/me/friends", "/c/channels/s2", false, "cold-scope"],
  ])("resolves %s -> %s with targetReady=%s as %s", (
    source,
    target,
    targetReady,
    mode,
  ) => {
    const committedFrame = { ...normalizeCommunityHref(source), revision: 4 }
    expect(resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: target,
      pending: true,
      targetReady,
    }).mode).toBe(mode)
  })

  it("keeps the committed surface and child alive during same-scope navigation", () => {
    const committedFrame = {
      ...normalizeCommunityHref("/c/channels/s1"),
      revision: 4,
    }
    expect(resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: "/c/channels/s1/c1",
      pending: true,
      targetReady: true,
    })).toEqual({
      mode: "same-scope-leaf",
      surface: "list",
      targetHref: "/c/channels/s1/c1",
      rail: { kind: "keep" },
      sidebar: { kind: "keep" },
      main: { kind: "keep" },
    })
  })

  it("keeps committed A as the source after the router publishes B", () => {
    const committedFrame = {
      ...normalizeCommunityHref("/c/channels/s1/c1"),
      revision: 7,
    }
    expect(resolveCommunityCheckpointPlan({
      committedFrame,
      targetHref: "/c/channels/s2/c2",
      pending: true,
      targetReady: false,
    })).toEqual({
      mode: "cold-scope",
      surface: "detail",
      targetHref: "/c/channels/s2/c2",
      rail: { kind: "target", view: "server", activeServerId: "s2" },
      sidebar: { kind: "server-skeleton", serverId: "s2" },
      main: { kind: "target-skeleton", href: "/c/channels/s2/c2" },
    })
  })

  it("settles non-structural publication but requires newer exact frame evidence structurally", () => {
    const c1 = { ...normalizeCommunityHref("/c/channels/s1/c1"), revision: 10 }
    expect(isPublishedNonStructuralCommit(
      c1,
      "/c/channels/s1/c1?b=2&a=1",
      "/c/channels/s1/c1?a=1&b=2#message",
    )).toBe(true)
    expect(isStructuralFrameCommit({
      committedFrame: c1,
      targetHref: "/c/channels/s1",
      baselineRevision: 10,
    })).toBe(false)
    expect(isStructuralFrameCommit({
      committedFrame: { ...normalizeCommunityHref("/c/channels/s1"), revision: 11 },
      targetHref: "/c/channels/s1",
      baselineRevision: 10,
    })).toBe(true)
    expect(isStructuralFrameCommit({
      committedFrame: { ...normalizeCommunityHref("/c/channels/s1/c1"), revision: 11 },
      targetHref: "/c/channels/s1",
      baselineRevision: 10,
    })).toBe(false)
  })

  it("advances frame revision only from a different structural commit marker", () => {
    const c1 = { ...normalizeCommunityHref("/c/channels/s1/c1"), revision: 4 }
    expect(advanceCommunityCommittedFrame(c1, "/c/channels/s1/c1")).toBe(c1)
    expect(advanceCommunityCommittedFrame(c1, "/c/channels/s1/c2")).toEqual({
      ...normalizeCommunityHref("/c/channels/s1/c2"),
      revision: 5,
    })
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

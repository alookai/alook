import { describe, expect, it } from "vitest"
import {
  channelHref,
  childChannelHref,
  removeCommunityParam,
  resolveCommunityRoute,
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
    ["/c/channels/server_1/parent_1/child_1", "detail", "/c/channels/server_1/parent_1"],
  ])("classifies %s", (pathname, surface, parentPath) => {
    expect(resolveCommunityRoute(pathname)).toEqual({ surface, parentPath })
  })

  it("builds root, top-level, and canonical child hrefs", () => {
    expect(serverRootHref("server_1")).toBe("/c/channels/server_1")
    expect(channelHref("server_1", "channel_1")).toBe("/c/channels/server_1/channel_1")
    expect(childChannelHref("server_1", "parent_1", "child_1")).toBe(
      "/c/channels/server_1/parent_1/child_1",
    )
  })

  it("removes one query key while preserving the rest and the hash", () => {
    expect(removeCommunityParam("/c/me/dm_1?seq=4&keep=1#x", "seq")).toBe(
      "/c/me/dm_1?keep=1#x",
    )
  })
})

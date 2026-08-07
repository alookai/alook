import { describe, expect, it } from "vitest"
import { buildChannelRouteModel } from "./use-channel-route-model"

const server = {
  id: "s1",
  name: "Server",
  categories: [{
    id: "cat1",
    name: "Channels",
    private: false,
    channels: [
      { id: "text1", name: "general", type: "text" },
      { id: "forum1", name: "forum", type: "forum" },
    ],
  }],
} as never

describe("buildChannelRouteModel", () => {
  it("classifies a top-level forum without treating it as a notify unit", () => {
    const model = buildChannelRouteModel(server, null, "forum1")
    expect(model).toMatchObject({ isForum: true, isChild: false, isNotifyUnit: false, routeHydrated: true })
  })

  it("classifies a child under a forum as a forum post", () => {
    const meta = { name: "post", parentChannelId: "forum1", parentMessageId: "m1", creatorId: "u1" }
    const model = buildChannelRouteModel(server, meta, "post1", { channelId: "post1", settled: true })
    expect(model).toMatchObject({ isForum: false, isChild: true, isForumPostChild: true, isNotifyUnit: true, routeHydrated: true })
    expect(model.parent?.id).toBe("forum1")
  })

  it("keeps an unresolved child unhydrated until authoritative meta settles", () => {
    expect(buildChannelRouteModel(server, null, "missing").routeHydrated).toBe(false)
  })

  it("does not consume child A metadata while child B is unresolved", () => {
    const stale = { name: "A", parentChannelId: "forum1", parentMessageId: "m1", creatorId: "u1" }
    const model = buildChannelRouteModel(server, stale, "post-b", { channelId: "post-a", settled: true })
    expect(model.currentChannelMeta).toBeNull()
    expect(model.parent).toBeNull()
    expect(model.isForumPostChild).toBe(false)
    expect(model.metaSettled).toBe(false)
    expect(model.routeHydrated).toBe(false)
  })

  it("derives the child subtype only after that child's metadata settles", () => {
    const meta = { name: "B", parentChannelId: "forum1", parentMessageId: "m2", creatorId: "u2" }
    const model = buildChannelRouteModel(server, meta, "post-b", { channelId: "post-b", settled: true })
    expect(model.parent?.id).toBe("forum1")
    expect(model.isForumPostChild).toBe(true)
    expect(model.routeHydrated).toBe(true)
  })
})

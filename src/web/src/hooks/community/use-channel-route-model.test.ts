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
    expect(model).toMatchObject({ isForum: true, isChild: false, isNotifyUnit: false, hydrated: true })
  })

  it("classifies a child under a forum as a forum post", () => {
    const meta = { name: "post", parentChannelId: "forum1", parentMessageId: "m1", creatorId: "u1" }
    const model = buildChannelRouteModel(server, meta, "post1")
    expect(model).toMatchObject({ isForum: false, isChild: true, isForumPostChild: true, isNotifyUnit: true, hydrated: true })
    expect(model.parent?.id).toBe("forum1")
  })

  it("keeps an unresolved child unhydrated until authoritative meta settles", () => {
    expect(buildChannelRouteModel(server, null, "missing").hydrated).toBe(false)
  })
})

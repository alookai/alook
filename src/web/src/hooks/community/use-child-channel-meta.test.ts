import { describe, expect, it } from "vitest"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"
import { pickRenderableChildMeta } from "./use-child-channel-meta"

const meta = (overrides: Partial<ChildChannelMeta> = {}): ChildChannelMeta => ({
  id: "post-1",
  serverId: "server-1",
  name: "post",
  type: "thread",
  parentChannelId: "forum-1",
  parentMessageId: "opener-1",
  creatorId: "user-1",
  archived: false,
  activityAt: "2026-08-09T00:00:00.000Z",
  verifiedEpoch: 2,
  ...overrides,
})

describe("child channel metadata stale rendering", () => {
  it("keeps a previously authorized snapshot renderable across a WS epoch", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(trusted, trusted, 3)).toBe(trusted)
  })

  it("does not render an old first response that was never trusted", () => {
    expect(pickRenderableChildMeta(meta({ verifiedEpoch: 2 }), undefined, 3)).toBeUndefined()
  })

  it("authoritative current-epoch archive removes a previously trusted snapshot", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(
      meta({ verifiedEpoch: 3, archived: true }),
      trusted,
      3,
    )).toBeUndefined()
  })
})

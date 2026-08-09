import { describe, expect, it } from "vitest"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"
import { isChildChannelMetaVerified } from "./use-child-channel-meta"

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

describe("child channel metadata access epoch", () => {
  it("fails closed while disconnected and until the current epoch validates", () => {
    expect(isChildChannelMetaVerified(meta(), 2, true)).toBe(true)
    expect(isChildChannelMetaVerified(meta(), 3, false)).toBe(false)
    expect(isChildChannelMetaVerified(meta(), 3, true)).toBe(false)
    expect(isChildChannelMetaVerified(meta({ verifiedEpoch: 3 }), 3, true)).toBe(true)
  })

  it("never verifies an archived child payload", () => {
    expect(isChildChannelMetaVerified(meta({ archived: true }), 2, true)).toBe(false)
  })
})

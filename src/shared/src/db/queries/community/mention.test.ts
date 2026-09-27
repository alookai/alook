import { describe, expect, it, vi } from "vitest"
import { listUnreadMentionScopes } from "./mention"

describe("listUnreadMentionScopes", () => {
  it("short-circuits an empty visibility scope and queries a non-empty scope", async () => {
    const rows = [{
      channelId: "channel_1",
      serverId: "server_1",
      parentChannelId: null,
      attentionCount: 2,
      lastAttentionSeq: 8,
    }]
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    chain.from = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.groupBy = vi.fn().mockResolvedValue(rows)
    const db = { select: vi.fn(() => chain) }

    await expect(listUnreadMentionScopes(db as never, "user_1", [])).resolves.toEqual([])
    await expect(listUnreadMentionScopes(db as never, "user_1", ["channel_1"])).resolves.toEqual(rows)
    expect(db.select).toHaveBeenCalledOnce()
    expect(chain.groupBy).toHaveBeenCalledOnce()
  })
})

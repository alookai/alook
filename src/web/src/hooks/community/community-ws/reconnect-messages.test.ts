import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import {
  reconcileFocusedMessageQueries,
  scheduleFocusedMessageGapRepair,
} from "./reconnect-messages"

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ channelId: string; seq?: number }>,
  reconcile: vi.fn<() => Promise<void>>(),
  purgeResource: vi.fn(async () => undefined),
  purgeChannel: vi.fn(),
}))

vi.mock("@/lib/community-db/collections", () => ({
  getCommunityDbRegistry: () => ({
    collections: {
      messages: { values: () => mocks.messages.values() },
    },
    reconcileMessageScope: mocks.reconcile,
    purgeMessageScope: mocks.purgeResource,
  }),
}))

vi.mock("@/lib/community-db/sync", () => ({
  purgeCommunityChannel: mocks.purgeChannel,
}))

vi.mock("@/stores/community/message-stream", () => ({
  getMessageOverlay: () => ({ liveById: new Map() }),
}))

beforeEach(() => {
  mocks.messages.length = 0
  mocks.reconcile.mockReset().mockResolvedValue(undefined)
  mocks.purgeResource.mockClear()
  mocks.purgeChannel.mockReset()
})

describe("canonical focused-message reconciliation", () => {
  it("does not repair a contiguous frame already covered by canonical rows", () => {
    const queryClient = new QueryClient()
    mocks.messages.push({ channelId: "channel", seq: 4 })

    expect(scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "channel", serverId: "server" },
      5,
    )).toBeNull()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it("shares one descriptor refresh for concurrent gap evidence", async () => {
    const queryClient = new QueryClient()
    let release!: () => void
    mocks.reconcile.mockReturnValue(new Promise<void>((resolve) => { release = resolve }))

    const first = scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "channel", serverId: "server" },
      8,
    )
    const second = scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "channel", serverId: "server" },
      9,
    )

    expect(second).toBe(first)
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(mocks.reconcile).toHaveBeenCalledWith("server-channel", "channel")
    release()
    await first
  })

  it("refreshes a DM through the descriptor instead of a legacy page cache", async () => {
    const queryClient = new QueryClient()

    await reconcileFocusedMessageQueries(queryClient, "dm", "dm-1")

    expect(mocks.reconcile).toHaveBeenCalledWith("dm", "dm-1")
  })

  it("atomically purges a definitively denied scope", async () => {
    const queryClient = new QueryClient()
    mocks.reconcile.mockRejectedValueOnce(new ApiError("forbidden", 403))

    await reconcileFocusedMessageQueries(queryClient, "channel", "denied")

    expect(mocks.purgeResource).toHaveBeenCalledWith("denied")
    expect(mocks.purgeChannel).toHaveBeenCalledWith(expect.anything(), "denied")
  })

  it("propagates transient refresh failures to reconnect policy accounting", async () => {
    const queryClient = new QueryClient()
    mocks.reconcile.mockRejectedValueOnce(new Error("offline"))

    await expect(reconcileFocusedMessageQueries(queryClient, "channel", "channel"))
      .rejects.toThrow("offline")
    expect(mocks.purgeResource).not.toHaveBeenCalled()
  })
})

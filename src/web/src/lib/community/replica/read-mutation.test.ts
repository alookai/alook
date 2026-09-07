import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({ apiFetch }))

import {
  clearCommunityReplicaReadMutations,
  sendCommunityReplicaReadMutation,
  settleCommunityReplicaReadMutations,
} from "./read-mutation"

describe("community Replica read mutation", () => {
  beforeEach(() => {
    apiFetch.mockReset()
    clearCommunityReplicaReadMutations("account-1")
  })

  it("shares one physical write and its successful receipt until canonical confirmation", async () => {
    const mutation = { channelId: "channel-1", messageId: "message-7", seq: 7 }
    const first = new AbortController()
    const second = new AbortController()
    let resolveWrite!: (value: unknown) => void
    apiFetch.mockReturnValue(new Promise((resolve) => { resolveWrite = resolve }))

    const coordinatorWrite = sendCommunityReplicaReadMutation(
      "account-1",
      mutation,
      first.signal,
    )
    const walReplay = sendCommunityReplicaReadMutation(
      "account-1",
      mutation,
      second.signal,
    )

    expect(apiFetch).toHaveBeenCalledOnce()
    resolveWrite({ changed: true, revision: 11, targetSeq: 7 })
    await expect(Promise.all([coordinatorWrite, walReplay])).resolves.toEqual([
      { changed: true, revision: 11, targetSeq: 7 },
      { changed: true, revision: 11, targetSeq: 7 },
    ])

    await sendCommunityReplicaReadMutation("account-1", mutation, second.signal)
    expect(apiFetch).toHaveBeenCalledOnce()

    settleCommunityReplicaReadMutations("account-1", "channel-1", 6)
    await sendCommunityReplicaReadMutation("account-1", mutation, second.signal)
    expect(apiFetch).toHaveBeenCalledOnce()

    settleCommunityReplicaReadMutations("account-1", "channel-1", 7)
    apiFetch.mockResolvedValue({ changed: false, revision: 11, targetSeq: 7 })
    await sendCommunityReplicaReadMutation("account-1", mutation, second.signal)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it("does not let an older successful receipt suppress a newer cursor", async () => {
    const signal = new AbortController().signal
    apiFetch
      .mockResolvedValueOnce({ changed: true, revision: 11, targetSeq: 7 })
      .mockResolvedValueOnce({ changed: true, revision: 12, targetSeq: 8 })

    await sendCommunityReplicaReadMutation(
      "account-1",
      { channelId: "channel-1", messageId: "message-7", seq: 7 },
      signal,
    )
    await sendCommunityReplicaReadMutation(
      "account-1",
      { channelId: "channel-1", messageId: "message-8", seq: 8 },
      signal,
    )

    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1]).toEqual([
      "/api/community/channels/channel-1/read",
      expect.objectContaining({
        body: JSON.stringify({ lastReadMessageId: "message-8" }),
      }),
    ])
  })

  it("does not cache a failed attempt", async () => {
    const mutation = { channelId: "channel-1", messageId: "message-7", seq: 7 }
    const signal = new AbortController().signal
    apiFetch
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ changed: true, revision: 11, targetSeq: 7 })

    await expect(sendCommunityReplicaReadMutation("account-1", mutation, signal))
      .rejects.toThrow("offline")
    await expect(sendCommunityReplicaReadMutation("account-1", mutation, signal))
      .resolves.toEqual({ changed: true, revision: 11, targetSeq: 7 })
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })
})

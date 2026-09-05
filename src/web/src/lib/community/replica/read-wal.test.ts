import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearCommunityReplicaReadWal,
  commitCommunityReplicaReadWal,
  listCommunityReplicaReadWal,
  settleCommunityReplicaReadWal,
} from "./read-wal"

const first = {
  channelId: "channel-1",
  messageId: "message-4",
  seq: 4,
  observedAt: "2026-09-06T00:00:00.000Z",
}

describe("community Replica read WAL", () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      get length() { return values.size },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      clear: () => values.clear(),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("commits synchronously and never regresses a channel watermark", () => {
    commitCommunityReplicaReadWal("account-1", first)
    commitCommunityReplicaReadWal("account-1", { ...first, messageId: "message-3", seq: 3 })

    expect(listCommunityReplicaReadWal("account-1")).toEqual([first])
  })

  it("settles only after canonical state reaches the durable watermark", () => {
    commitCommunityReplicaReadWal("account-1", first)
    settleCommunityReplicaReadWal("account-1", first.channelId, 3)
    expect(listCommunityReplicaReadWal("account-1")).toEqual([first])

    settleCommunityReplicaReadWal("account-1", first.channelId, 4)
    expect(listCommunityReplicaReadWal("account-1")).toEqual([])
  })

  it("isolates accounts and clears one account without touching another", () => {
    commitCommunityReplicaReadWal("account-1", first)
    commitCommunityReplicaReadWal("account-2", { ...first, channelId: "channel-2" })

    clearCommunityReplicaReadWal("account-1")
    expect(listCommunityReplicaReadWal("account-1")).toEqual([])
    expect(listCommunityReplicaReadWal("account-2")).toHaveLength(1)
  })
})

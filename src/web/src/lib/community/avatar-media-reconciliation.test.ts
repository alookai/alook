import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getHuman: vi.fn(),
  getBot: vi.fn(),
  waitUntil: vi.fn(),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      user: {
        ...actual.queries.user,
        getLiveHumanAvatarState: (...args: unknown[]) => mocks.getHuman(...args),
      },
      communityBot: {
        ...actual.queries.communityBot,
        getLiveBotAvatar: (...args: unknown[]) => mocks.getBot(...args),
      },
    },
  }
})

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: mocks.waitUntil } }),
}))

import {
  cleanupAvatarCandidate,
  ensureAvatarAliasPresent,
  scheduleAvatarMediaReconciliation,
} from "./avatar-media-reconciliation"

function object(bytes: number[], label: string) {
  return {
    arrayBuffer: vi.fn(async () => Uint8Array.from(bytes).buffer),
    httpMetadata: { contentType: "image/webp", cacheControl: `private-${label}` },
    customMetadata: { source: label },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("avatar alias reconciliation", () => {
  it("copies buffered known-length bytes and preserves HTTP/custom metadata", async () => {
    const current = "user-avatar/u1/objects/current"
    mocks.getHuman.mockResolvedValue({ avatarVersion: 3, avatarObjectKey: current })
    const source = object([1, 2, 3, 4], "current")
    const head = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ key: "user-avatar/u1" })
    const get = vi.fn().mockResolvedValue(source)
    const put = vi.fn().mockResolvedValue(undefined)

    await expect(ensureAvatarAliasPresent(
      {} as never,
      { head, get, put, delete: vi.fn() } as never,
      { kind: "human", id: "u1" },
    )).resolves.toBe(true)

    expect(get).toHaveBeenCalledWith(current)
    expect(put).toHaveBeenCalledOnce()
    const [key, bytes, options] = put.mock.calls[0]!
    expect(key).toBe("user-avatar/u1")
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect((bytes as ArrayBuffer).byteLength).toBe(4)
    expect(options).toEqual({
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    })
  })

  it("retries a reordered alias copy until the bytes match the authoritative pointer", async () => {
    const oldKey = "user-avatar/u1/objects/old"
    const newKey = "user-avatar/u1/objects/new"
    mocks.getHuman
      .mockResolvedValueOnce({ avatarVersion: 1, avatarObjectKey: oldKey })
      .mockResolvedValueOnce({ avatarVersion: 2, avatarObjectKey: newKey })
      .mockResolvedValueOnce({ avatarVersion: 2, avatarObjectKey: newKey })
      .mockResolvedValueOnce({ avatarVersion: 2, avatarObjectKey: newKey })
    const get = vi.fn(async (key: string) => key === oldKey
      ? object([1], "old")
      : object([2], "new"))
    const put = vi.fn().mockResolvedValue(undefined)
    const head = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ key: "user-avatar/u1" })

    await expect(ensureAvatarAliasPresent(
      {} as never,
      { head, get, put, delete: vi.fn() } as never,
      { kind: "human", id: "u1" },
    )).resolves.toBe(true)

    expect(get.mock.calls.map((call) => call[0])).toEqual([oldKey, newKey])
    expect(put).toHaveBeenCalledTimes(2)
    const finalBytes = put.mock.calls[1]![1] as ArrayBuffer
    expect([...new Uint8Array(finalBytes)]).toEqual([2])
  })

  it("returns false without copying an invalid or legacy pointer", async () => {
    mocks.getHuman.mockResolvedValue({ avatarVersion: 0, avatarObjectKey: null })
    const get = vi.fn()
    const put = vi.fn()

    await expect(ensureAvatarAliasPresent(
      {} as never,
      { head: vi.fn().mockResolvedValue(null), get, put, delete: vi.fn() } as never,
      { kind: "human", id: "u1" },
    )).resolves.toBe(false)
    expect(get).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("recognizes an already-present bot alias", async () => {
    const head = vi.fn().mockResolvedValue({ key: "bot-avatar/b1" })

    await expect(ensureAvatarAliasPresent(
      {} as never,
      { head, get: vi.fn(), put: vi.fn(), delete: vi.fn() } as never,
      { kind: "bot", id: "b1" },
    )).resolves.toBe(true)

    expect(head).toHaveBeenCalledWith("bot-avatar/b1")
    expect(mocks.getBot).not.toHaveBeenCalled()
  })

  it("returns false after three continuously reordered alias copies", async () => {
    let read = 0
    mocks.getHuman.mockImplementation(async () => {
      read += 1
      return {
        avatarVersion: read,
        avatarObjectKey: `user-avatar/u1/objects/object-${read}`,
      }
    })
    const get = vi.fn().mockResolvedValue(object([1], "moving"))
    const put = vi.fn().mockResolvedValue(undefined)

    await expect(ensureAvatarAliasPresent(
      {} as never,
      { head: vi.fn().mockResolvedValue(null), get, put, delete: vi.fn() } as never,
      { kind: "human", id: "u1" },
    )).resolves.toBe(false)

    expect(get).toHaveBeenCalledTimes(3)
    expect(put).toHaveBeenCalledTimes(3)
  })
})

describe("avatar candidate cleanup", () => {
  it("deletes only a verified owned child that is no longer current", async () => {
    mocks.getHuman.mockResolvedValue({
      avatarVersion: 4,
      avatarObjectKey: "user-avatar/u1/objects/current",
    })
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(cleanupAvatarCandidate(
      {} as never,
      { delete: remove } as never,
      { kind: "human", id: "u1" },
      "user-avatar/u1/objects/displaced",
    )).resolves.toBe("deleted")
    expect(remove).toHaveBeenCalledWith("user-avatar/u1/objects/displaced")
  })

  it("retains current, alias, foreign, and unverified candidates", async () => {
    const current = "bot-avatar/b1/objects/current"
    mocks.getBot.mockResolvedValue({ avatarVersion: 2, avatarObjectKey: current })
    const remove = vi.fn()

    await expect(cleanupAvatarCandidate(
      {} as never,
      { delete: remove } as never,
      { kind: "bot", id: "b1" },
      current,
    )).resolves.toBe("retained_current")
    await expect(cleanupAvatarCandidate(
      {} as never,
      { delete: remove } as never,
      { kind: "bot", id: "b1" },
      "bot-avatar/b1",
    )).resolves.toBe("retained_unowned")
    await expect(cleanupAvatarCandidate(
      {} as never,
      { delete: remove } as never,
      { kind: "bot", id: "b1" },
      "bot-avatar/b2/objects/foreign",
    )).resolves.toBe("retained_unowned")

    mocks.getBot.mockRejectedValueOnce(new Error("D1 unavailable"))
    await expect(cleanupAvatarCandidate(
      {} as never,
      { delete: remove } as never,
      { kind: "bot", id: "b1" },
      "bot-avatar/b1/objects/unknown",
    )).resolves.toBe("retained_unverified")
    expect(remove).not.toHaveBeenCalled()
  })

  it("registers the same reconciliation promise with waitUntil", async () => {
    mocks.getHuman.mockResolvedValue({
      avatarVersion: 1,
      avatarObjectKey: "user-avatar/u1/objects/current",
    })
    const bucket = {
      get: vi.fn().mockResolvedValue(object([7], "current")),
      put: vi.fn().mockResolvedValue(undefined),
      head: vi.fn(),
      delete: vi.fn(),
    }

    const work = scheduleAvatarMediaReconciliation(
      {} as never,
      bucket as never,
      { subject: { kind: "human", id: "u1" }, candidates: [] },
    )

    expect(mocks.waitUntil).toHaveBeenCalledWith(work)
    await expect(work).resolves.toBeUndefined()
  })

  it("absorbs an alias-copy failure in background reconciliation", async () => {
    mocks.getHuman.mockRejectedValue(new Error("D1 unavailable"))
    const work = scheduleAvatarMediaReconciliation(
      {} as never,
      { get: vi.fn(), put: vi.fn(), head: vi.fn(), delete: vi.fn() } as never,
      { subject: { kind: "human", id: "u1" }, candidates: [] },
    )

    await expect(work).resolves.toBeUndefined()
  })

  it("continues after an incomplete alias copy and an exact child cleanup failure", async () => {
    mocks.getHuman
      .mockResolvedValueOnce({ avatarVersion: 0, avatarObjectKey: null })
      .mockResolvedValueOnce({
        avatarVersion: 2,
        avatarObjectKey: "user-avatar/u1/objects/current",
      })
    const remove = vi.fn().mockRejectedValue(new Error("R2 unavailable"))
    const work = scheduleAvatarMediaReconciliation(
      {} as never,
      { get: vi.fn(), put: vi.fn(), head: vi.fn(), delete: remove } as never,
      {
        subject: { kind: "human", id: "u1" },
        candidates: ["user-avatar/u1/objects/displaced"],
      },
    )

    await expect(work).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith("user-avatar/u1/objects/displaced")
  })
})

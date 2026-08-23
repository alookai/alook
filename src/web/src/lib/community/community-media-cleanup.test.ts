import { beforeEach, describe, expect, it, vi } from "vitest"

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, createLogger: () => ({ warn }) }
})

import {
  COMMUNITY_MEDIA_DELETE_BATCH_SIZE,
  deleteCommunityMediaObjects,
  scheduleCommunityMediaCleanup,
} from "./community-media-cleanup"

describe("community media cleanup", () => {
  const deleteObjects = vi.fn<(keys: string | string[]) => Promise<void>>()
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    waitUntil.mockReset()
    deleteObjects.mockResolvedValue(undefined)
  })

  it("deduplicates, filters empty keys, and registers one complete waitUntil chain", async () => {
    scheduleCommunityMediaCleanup({ delete: deleteObjects }, { waitUntil }, {
      keys: ["original", "thumbnail", "original", ""],
      warning: { event: "cleanup_failed", fields: { channelId: "c1" } },
    })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
    expect(deleteObjects).toHaveBeenCalledTimes(1)
    expect(deleteObjects).toHaveBeenCalledWith(["original", "thumbnail"])
  })

  it("deletes sequential chunks at the current R2 1000-key limit", async () => {
    const keys = Array.from(
      { length: COMMUNITY_MEDIA_DELETE_BATCH_SIZE + 1 },
      (_, index) => `key-${index}`,
    )
    scheduleCommunityMediaCleanup({ delete: deleteObjects }, { waitUntil }, {
      keys,
      warning: { event: "cleanup_failed", fields: { serverId: "s1" } },
    })

    await waitUntil.mock.calls[0]![0]
    expect(deleteObjects).toHaveBeenCalledTimes(2)
    expect(deleteObjects.mock.calls[0]![0]).toHaveLength(COMMUNITY_MEDIA_DELETE_BATCH_SIZE)
    expect(deleteObjects.mock.calls[1]![0]).toEqual([`key-${COMMUNITY_MEDIA_DELETE_BATCH_SIZE}`])
  })

  it("does not register work for no keys", () => {
    scheduleCommunityMediaCleanup({ delete: deleteObjects }, { waitUntil }, {
      keys: [""],
      warning: { event: "cleanup_failed", fields: { serverId: "s1" } },
    })
    expect(waitUntil).not.toHaveBeenCalled()
    expect(deleteObjects).not.toHaveBeenCalled()
  })

  it("swallows a synchronous waitUntil rejection and logs once without raw detail", async () => {
    waitUntil.mockImplementationOnce(() => {
      throw new TypeError("secret registration detail")
    })

    expect(() => scheduleCommunityMediaCleanup({ delete: deleteObjects }, { waitUntil }, {
      keys: ["secret/key"],
      warning: { event: "cleanup_failed", fields: { serverId: "s1" } },
    })).not.toThrow()
    await vi.waitFor(() => expect(deleteObjects).toHaveBeenCalledWith(["secret/key"]))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("cleanup_failed", {
      serverId: "s1",
      keyCount: 1,
      errorCategory: "TypeError",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it.each([
    [new TypeError("secret type detail"), "TypeError"],
    [new Error("secret provider detail"), "Error"],
    ["secret non-error detail", "NonError"],
  ] as const)("sanitizes a rejected cleanup as %s", async (rejection, category) => {
    deleteObjects.mockRejectedValueOnce(rejection)
    scheduleCommunityMediaCleanup({ delete: deleteObjects }, { waitUntil }, {
      keys: ["secret/key"],
      warning: { event: "cleanup_failed", fields: { serverId: "s1" } },
    })

    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("cleanup_failed", {
      serverId: "s1",
      keyCount: 1,
      errorCategory: category,
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it("exposes an awaited delete path for CAS compensation", async () => {
    await deleteCommunityMediaObjects({ delete: deleteObjects }, ["new", "new", ""])
    expect(deleteObjects).toHaveBeenCalledWith(["new"])
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import { channelRefDirectoryQueryFn } from "./use-channel-ref-directory"

describe("channelRefDirectoryQueryFn", () => {
  beforeEach(() => vi.clearAllMocks())

  it("loads the complete directory through one lightweight request", async () => {
    const directory = [
      {
        id: "server_1",
        name: "Studio",
        discriminator: "0042",
        channels: [{ id: "channel_1", name: "general" }],
      },
    ]
    apiFetch.mockResolvedValue({ directory })

    await expect(channelRefDirectoryQueryFn()).resolves.toEqual(directory)
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/channel-directory")
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})

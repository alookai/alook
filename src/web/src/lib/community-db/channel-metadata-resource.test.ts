import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import {
  channelMetadataResourceKey,
  createChannelMetadataResourceQueryFn,
} from "./channel-metadata-resource"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

describe("channel metadata resource", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset())

  it("rejects a query key outside its account resource namespace", async () => {
    const query = createChannelMetadataResourceQueryFn(new QueryClient(), "viewer")

    await expect(query({
      queryKey: ["community", "db", "other", "channel-resource", "metadata", "s1", "c1"],
      signal: new AbortController().signal,
    } as never)).rejects.toThrow("invalid channel metadata resource key")
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("rejects metadata that belongs to a different channel scope", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      id: "different-channel",
      serverId: "s1",
      name: "Wrong",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: null,
      createdAt: "2026-09-29T00:00:00.000Z",
    } as never)
    const query = createChannelMetadataResourceQueryFn(new QueryClient(), "viewer")

    await expect(query({
      queryKey: channelMetadataResourceKey("viewer", "s1", "c1"),
      signal: new AbortController().signal,
    } as never)).rejects.toThrow("Channel metadata scope mismatch")
  })
})

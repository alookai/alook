import { QueryClient, type QueryFunctionContext } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import {
  channelResourceQueryKey,
  createChannelResourceQueryFn,
  dmsResourceKey,
} from "./dms-resource"
import { channelMetadataResourceKey } from "./channel-metadata-resource"
import { serverDetailResourceKey } from "./server-detail-resource"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

function context(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return {
    client: queryClient,
    queryKey,
    signal: new AbortController().signal,
    meta: undefined,
  } as QueryFunctionContext
}

describe("combined channel resource routing", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === "/api/community/users/me/dms") return {
        conversations: [{
          id: "dm-1",
          userId: "peer-1",
          name: "Peer",
          discriminator: "0001",
          avatar: "",
          avatarVersion: 0,
          status: "offline",
          sub: "",
          preview: "hello",
          activityAt: "2026-09-29T00:00:00.000Z",
          lastUnreadSeq: 7,
        }],
      }
      if (path === "/api/community/servers/server-1/categories") return { categories: [] }
      if (path === "/api/community/servers/server-1/channels") return { channels: [] }
      if (path === "/api/community/channels/channel-1") return {
        id: "channel-1",
        serverId: "server-1",
        name: "Channel",
        type: "text",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        archived: false,
        lastMessageAt: null,
        createdAt: "2026-09-29T00:00:00.000Z",
      }
      throw new Error(`unexpected API fetch: ${path}`)
    })
  })

  it("uses the DM key by default and projects an unread boundary", async () => {
    expect(channelResourceQueryKey("viewer")).toEqual(dmsResourceKey("viewer"))
    const queryClient = new QueryClient()
    const resource = await createChannelResourceQueryFn(queryClient, "viewer")(
      context(queryClient, dmsResourceKey("viewer")),
    )

    expect(resource).toMatchObject({
      conversations: [{ id: "dm-1", lastUnreadSeq: 7 }],
      channels: [{ id: "dm-1", lastUnreadSeq: 7 }],
    })
  })

  it("routes server, metadata, DM, and unknown resource keys independently", async () => {
    const queryClient = new QueryClient()
    const query = createChannelResourceQueryFn(queryClient, "viewer")

    await expect(query(context(
      queryClient,
      serverDetailResourceKey("viewer", "server-1"),
    ))).resolves.toMatchObject({ serverId: "server-1" })
    await expect(query(context(
      queryClient,
      channelMetadataResourceKey("viewer", "server-1", "channel-1"),
    ))).resolves.toMatchObject({ metadata: { id: "channel-1" } })
    await expect(query(context(
      queryClient,
      dmsResourceKey("viewer"),
    ))).resolves.toMatchObject({ conversations: [{ id: "dm-1" }] })
    await expect(query(context(queryClient, ["community", "unknown"])))
      .resolves.toEqual({
        conversations: [],
        categories: [],
        channels: [],
        channelMemberships: [],
        profiles: [],
      })
  })
})

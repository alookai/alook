import { QueryClient, type QueryFunctionContext } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createServerDetailResourceQueryFn,
  selectServerDetailCategories,
  selectServerDetailChannels,
  serverDetailResourceBaseKey,
  serverDetailResourceChannelIds,
  serverDetailResourceKey,
  serverDetailResourceQueryKey,
} from "@/lib/community-db/server-detail-resource"
import { ApiError } from "@/lib/errors"

const apiFetch = vi.fn()

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) }
})

function detailContext(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  signal = new AbortController().signal,
) {
  return { queryKey, signal, meta: undefined, client: queryClient } as QueryFunctionContext
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/categories")) {
      return { categories: [{ id: "category-1", name: "General", private: false }] }
    }
    if (path.endsWith("/channels")) {
      return {
        channels: [{
          id: "channel-1",
          name: "chat",
          categoryId: "category-1",
          unread: true,
          type: "text",
        }],
      }
    }
    throw new Error(`unexpected ${path}`)
  })
})

describe("server detail raw resource", () => {
  it("uses the base key without subset options and scopes one exact server filter", () => {
    expect(serverDetailResourceQueryKey("viewer")).toEqual(
      serverDetailResourceBaseKey("viewer"),
    )
    expect(serverDetailResourceQueryKey("viewer", {
      where: {
        type: "func",
        name: "eq",
        args: [
          { type: "ref", path: ["serverId"] },
          { type: "val", value: "server-1" },
        ],
      },
    } as never)).toEqual(serverDetailResourceKey("viewer", "server-1"))
    expect(serverDetailResourceQueryKey("viewer", {
      where: {
        type: "func",
        name: "eq",
        args: [
          { type: "ref", path: ["serverId"] },
          { type: "val", value: 42 },
        ],
      },
    } as never)).toEqual(serverDetailResourceBaseKey("viewer"))
  })

  it("fetches the exact server resource and normalizes both collection envelopes", async () => {
    const queryClient = new QueryClient()
    const queryFn = createServerDetailResourceQueryFn(queryClient, "viewer")

    const resource = await queryFn(detailContext(
      queryClient,
      serverDetailResourceKey("viewer", "server-1"),
    ))

    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/community/servers/server-1/categories",
      "/api/community/servers/server-1/channels",
    ])
    expect(resource).toMatchObject({
      serverId: "server-1",
      categories: [{ id: "category-1", serverId: "server-1", position: 0 }],
      channels: [{
        id: "channel-1",
        serverId: "server-1",
        categoryId: "category-1",
        unread: false,
        position: 0,
      }],
    })
    expect(selectServerDetailCategories(resource)).toBe(resource.categories)
    expect(selectServerDetailChannels(resource)).toBe(resource.channels)
  })

  it("deduplicates concurrent consumers through the shared raw query key", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryFn = createServerDetailResourceQueryFn(queryClient, "viewer")
    const options = {
      queryKey: serverDetailResourceKey("viewer", "server-1"),
      queryFn,
      staleTime: Infinity,
    }

    const [left, right] = await Promise.all([
      queryClient.fetchQuery(options),
      queryClient.fetchQuery(options),
    ])

    expect(left).toBe(right)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it("does not fetch an unscoped base descriptor", async () => {
    const queryClient = new QueryClient()
    const resource = await createServerDetailResourceQueryFn(queryClient, "viewer")(
      detailContext(queryClient, serverDetailResourceBaseKey("viewer")),
    )

    expect(resource).toEqual({ serverId: "", categories: [], channels: [] })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("forwards the query-owned abort signal to both endpoint requests", async () => {
    const queryClient = new QueryClient()
    const controller = new AbortController()
    await createServerDetailResourceQueryFn(queryClient, "viewer")(
      detailContext(queryClient, serverDetailResourceKey("viewer", "server-1"), controller.signal),
    )

    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      "/api/community/servers/server-1/categories",
      { signal: controller.signal },
    )
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/community/servers/server-1/channels",
      { signal: controller.signal },
    )
  })

  it("evicts a forbidden server resource before rethrowing the API error", async () => {
    const queryClient = new QueryClient()
    const key = serverDetailResourceKey("viewer", "server-1")
    queryClient.setQueryData(key, { serverId: "server-1", categories: [], channels: [] })
    const forbidden = new ApiError("forbidden", 403)
    apiFetch.mockRejectedValue(forbidden)

    await expect(createServerDetailResourceQueryFn(queryClient, "viewer")(
      detailContext(queryClient, key),
    )).rejects.toBe(forbidden)

    expect(queryClient.getQueryState(key)).toBeUndefined()
  })

  it("orders live landing channels by category, position, and id", () => {
    const row = (id: string, categoryId: string | null, position: number, extra = {}) => ({
      id,
      serverId: "server-1",
      categoryId,
      name: id,
      type: "text" as const,
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      position,
      archived: false,
      muted: false,
      unread: false,
      tags: [],
      pending: false,
      lastMessageAt: null,
      ...extra,
    })
    expect(serverDetailResourceChannelIds({
      serverId: "server-1",
      categories: [
        { id: "later", serverId: "server-1", name: "Later", position: 2, private: false, creatorId: null, pending: false },
        { id: "first", serverId: "server-1", name: "First", position: 0, private: false, creatorId: null, pending: false },
      ],
      channels: [
        row("uncategorized", null, 0),
        row("uncategorized-z", null, 1),
        row("z", "first", 1),
        row("a", "first", 1),
        row("later", "later", 0),
        row("pending", "first", 0, { pending: true }),
        row("thread", "first", 0, { type: "thread" }),
      ],
    })).toEqual(["a", "z", "later", "uncategorized", "uncategorized-z"])
  })
})

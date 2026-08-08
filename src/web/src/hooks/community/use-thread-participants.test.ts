import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutationConfig = {
  mutationFn: (userId: string) => Promise<unknown>
  onSuccess?: (data: unknown, userId: string) => void
}

let config: MutationConfig
let queryClient: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useMutation: (next: MutationConfig) => {
      config = next
      return {}
    },
  }
})

function sidebarData() {
  return {
    channels: [],
    included: { parentMessages: [] },
    serverNow: "2026-08-08T00:00:00.000Z",
    threads: [{
      id: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
      title: "Post",
      activityAt: "2026-08-08T00:00:00.000Z",
      expiresAt: "2026-08-11T00:00:00.000Z",
      unread: false,
    }],
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(undefined)
  queryClient = new QueryClient()
})

describe("useRemoveThreadParticipant", () => {
  it("removes the child from every sidebar view when the viewer leaves", async () => {
    const key = communityKeys.forumSidebarThreadsView("server_1", "post_1")
    queryClient.setQueryData(key, sidebarData())
    const { useRemoveThreadParticipant } = await import("./use-thread-participants")
    useRemoveThreadParticipant("post_1", "server_1", "viewer_1")

    const result = await config.mutationFn("viewer_1")
    config.onSuccess?.(result, "viewer_1")

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/post_1/participants/viewer_1",
      { method: "DELETE" },
    )
    expect(queryClient.getQueryData<ReturnType<typeof sidebarData>>(key)?.threads).toEqual([])
  })

  it("keeps the viewer's sidebar row when the creator removes someone else", async () => {
    const key = communityKeys.forumSidebarThreadsView("server_1", null)
    queryClient.setQueryData(key, sidebarData())
    const { useRemoveThreadParticipant } = await import("./use-thread-participants")
    useRemoveThreadParticipant("post_1", "server_1", "viewer_1")

    const result = await config.mutationFn("other_1")
    config.onSuccess?.(result, "other_1")

    expect(queryClient.getQueryData<ReturnType<typeof sidebarData>>(key)?.threads).toHaveLength(1)
  })
})

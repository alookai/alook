import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  disposeAccountUnreadProjection,
  getAccountUnreadProjection,
} from "./account-unread-projection"

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
    serverClockOffsetMs: 0,
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

afterEach(() => {
  disposeAccountUnreadProjection(queryClient)
  queryClient.clear()
})

describe("useRemoveThreadParticipant", () => {
  it("removes the child from every sidebar view when the viewer leaves", async () => {
    const key = communityKeys.forumSidebarThreads("server_1")
    const metaKey = communityKeys.channelMeta("server_1", "post_1")
    queryClient.setQueryData(key, sidebarData())
    queryClient.setQueryData(metaKey, { id: "post_1", parentChannelId: "forum_1" })
    const unreadProjection = getAccountUnreadProjection(queryClient, "viewer_1")
    unreadProjection.recordArrival({
      channelId: "post_1",
      serverId: "server_1",
      seq: 7,
    })
    const { useRemoveThreadParticipant } = await import("./use-thread-participants")
    useRemoveThreadParticipant("post_1", "server_1", "viewer_1")

    const result = await config.mutationFn("viewer_1")
    config.onSuccess?.(result, "viewer_1")

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/post_1/participants/viewer_1",
      { method: "DELETE" },
    )
    expect(queryClient.getQueryData<ReturnType<typeof sidebarData>>(key)?.threads).toEqual([])
    expect(queryClient.getQueryData(metaKey)).toEqual({ id: "post_1", parentChannelId: "forum_1" })
    expect(unreadProjection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(false)
  })

  it("does not retire viewer unread scope when participant removal fails", async () => {
    const unreadProjection = getAccountUnreadProjection(queryClient, "viewer_1")
    unreadProjection.recordArrival({
      channelId: "post_1",
      serverId: "server_1",
      seq: 7,
    })
    apiFetchMock.mockRejectedValueOnce(new Error("failed"))
    const { useRemoveThreadParticipant } = await import("./use-thread-participants")
    useRemoveThreadParticipant("post_1", "server_1", "viewer_1")

    await expect(config.mutationFn("viewer_1")).rejects.toThrow("failed")

    expect(unreadProjection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(true)
  })

  it("keeps the viewer's sidebar row when the creator removes someone else", async () => {
    const key = communityKeys.forumSidebarThreads("server_1")
    queryClient.setQueryData(key, sidebarData())
    const unreadProjection = getAccountUnreadProjection(queryClient, "viewer_1")
    unreadProjection.recordArrival({
      channelId: "post_1",
      serverId: "server_1",
      seq: 7,
    })
    const { useRemoveThreadParticipant } = await import("./use-thread-participants")
    useRemoveThreadParticipant("post_1", "server_1", "viewer_1")

    const result = await config.mutationFn("other_1")
    config.onSuccess?.(result, "other_1")

    expect(queryClient.getQueryData<ReturnType<typeof sidebarData>>(key)?.threads).toHaveLength(1)
    expect(unreadProjection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(true)
  })

  it("does not revalidate the viewer's forum access when adding someone else", async () => {
    const key = communityKeys.forumSidebarThreads("server_1")
    queryClient.setQueryData(key, sidebarData())
    const { useAddThreadParticipant } = await import("./use-thread-participants")
    useAddThreadParticipant("post_1", "server_1", "viewer_1")

    const result = await config.mutationFn("other_1")
    config.onSuccess?.(result, "other_1")

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryData<ReturnType<typeof sidebarData>>(key)?.threads).toHaveLength(1)
  })

  it("does not touch forum sidebar resources for an ordinary text thread", async () => {
    const baseKey = communityKeys.forumSidebarThreads("server_1")
    const retainedKey = communityKeys.forumSidebarRetained("server_1", "forum_post")
    const metaKey = communityKeys.channelMeta("server_1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("server_1", "opener_1")
    queryClient.setQueryData(baseKey, sidebarData())
    queryClient.setQueryData(retainedKey, { id: "forum_post" })
    queryClient.setQueryData(metaKey, { id: "text_thread", parentChannelId: "text_parent" })
    queryClient.setQueryData(hintKey, { id: "opener_1", content: "Title" })
    const before = {
      base: queryClient.getQueryData(baseKey),
      retained: queryClient.getQueryData(retainedKey),
      meta: queryClient.getQueryData(metaKey),
      hint: queryClient.getQueryData(hintKey),
    }
    const { useAddThreadParticipant, useRemoveThreadParticipant } = await import("./use-thread-participants")

    useAddThreadParticipant("text_thread", undefined, "viewer_1")
    let result = await config.mutationFn("viewer_1")
    config.onSuccess?.(result, "viewer_1")
    useRemoveThreadParticipant("text_thread", "server_1", "viewer_1", false)
    result = await config.mutationFn("viewer_1")
    config.onSuccess?.(result, "viewer_1")

    expect(queryClient.getQueryData(baseKey)).toBe(before.base)
    expect(queryClient.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryData(retainedKey)).toBe(before.retained)
    expect(queryClient.getQueryData(metaKey)).toBe(before.meta)
    expect(queryClient.getQueryData(hintKey)).toBe(before.hint)
  })
})

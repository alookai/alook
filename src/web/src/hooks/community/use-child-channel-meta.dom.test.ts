import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelSchema } from "@/lib/community-db/schema"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  pickRenderableChildMeta,
  sameChildChannelMeta,
  updateTrustedChildMeta,
  useChildChannelMeta,
} from "./use-child-channel-meta"

const meta = (overrides: Partial<ChildChannelMeta> = {}): ChildChannelMeta => ({
  id: "post-1",
  serverId: "server-1",
  name: "post",
  type: "thread",
  parentChannelId: "forum-1",
  parentMessageId: "opener-1",
  creatorId: "user-1",
  archived: false,
  activityAt: "2026-08-09T00:00:00.000Z",
  verifiedEpoch: 2,
  ...overrides,
})

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({
    id: "post-1",
    serverId: "server-1",
    name: "post",
    type: "thread",
    parentChannelId: "forum-1",
    parentMessageId: "opener-1",
    creatorId: "user-1",
    archived: false,
    lastMessageAt: "2026-08-09T00:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
  })

})

describe("child channel metadata stale rendering", () => {
  it("compares every durable child metadata field", () => {
    const left = meta()
    expect(sameChildChannelMeta(left, { ...left })).toBe(true)
    expect(sameChildChannelMeta(left, { ...left, verifiedEpoch: 3 })).toBe(false)
    const trusted = { channelId: left.id, meta: left }
    expect(updateTrustedChildMeta(trusted, left.id, { ...left })).toBe(trusted)
  })

  it("keeps a previously authorized snapshot renderable across a WS epoch", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(trusted, trusted, 3)).toBe(trusted)
  })

  it("does not render an old first response that was never trusted", () => {
    expect(pickRenderableChildMeta(meta({ verifiedEpoch: 2 }), undefined, 3)).toBeUndefined()
  })

  it("authoritative current-epoch archive removes a previously trusted snapshot", () => {
    const trusted = meta({ verifiedEpoch: 2 })
    expect(pickRenderableChildMeta(
      meta({ verifiedEpoch: 3, archived: true }),
      trusted,
      3,
    )).toBeUndefined()
  })

  it("starts exact metadata loading without waiting for the forum sidebar", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    renderHook(() => useChildChannelMeta("server-1", "post-1", true), { wrapper })

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/post-1",
      expect.objectContaining({ authenticationAccount: "viewer", signal: expect.any(AbortSignal) }),
    )
    expect(queryClient.getQueryData(
      communityKeys.channelMeta("server-1", "post-1"),
    )).toMatchObject({ id: "post-1" })
    expect(createCommunityDbRegistry(queryClient, "viewer").collections.channels.get("post-1"))
      .toMatchObject({ parentChannelId: "forum-1" })
  })

  it("renders current-account canonical structure without granting permission while exact metadata revalidates", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const { client: queryClient } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const cached = meta({ verifiedEpoch: createCommunityDbRegistry(queryClient, "viewer").runtime.ws.get().accessEpoch })
    createCommunityDbRegistry(queryClient, "viewer").collections.channels.utils.writeUpsert(channelSchema.parse({
      ...cached, position: 0, muted: false, unread: false, tags: [], pending: false,
      lastMessageAt: cached.activityAt,
    }))
    const rendered = renderHook(
      () => useChildChannelMeta("server-1", "post-1", true, cached),
      { wrapper },
    )

    expect(rendered.result.current).toMatchObject({
      data: { id: cached.id, parentChannelId: cached.parentChannelId },
      isVerified: false,
      isPlaceholderData: false,
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    rendered.unmount()
  })

  it("builds a structural placeholder from a complete canonical thread row", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const { client: queryClient } = await createCommunityQueryOwner()
    createCommunityDbRegistry(queryClient, "viewer").collections.channels.utils.writeUpsert(channelSchema.parse({
      id: "post-1",
      serverId: "server-1",
      name: "post",
      type: "thread",
      parentChannelId: "forum-1",
      parentMessageId: "opener-1",
      creatorId: null,
      archived: false,
      lastMessageAt: undefined,
      position: 0, muted: false, unread: false, tags: [], pending: false,
    }))
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )

    const rendered = renderHook(
      () => useChildChannelMeta("server-1", "post-1", true),
      { wrapper },
    )

    expect(rendered.result.current).toMatchObject({
      data: { creatorId: null, activityAt: "" },
      isVerified: false,
      isPlaceholderData: false,
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    rendered.unmount()
  })

  it("does not retry terminal metadata failures before route ejection", async () => {
    apiFetchMock.mockRejectedValue(new ApiError("missing", 404))
    const { client: queryClient } = await createCommunityQueryOwner()
    queryClient.setDefaultOptions({ queries: { retryDelay: 0 } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(
      () => useChildChannelMeta("server-1", "post-1", true),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledOnce()
  })

  it("retries one transient metadata failure", async () => {
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const { client: queryClient } = await createCommunityQueryOwner()
    queryClient.setDefaultOptions({ queries: { retryDelay: 0 } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(
      () => useChildChannelMeta("server-1", "post-1", true),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it("preserves the trusted object when an exact refetch returns identical metadata", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    queryClient.setDefaultOptions({ queries: { retry: false, structuralSharing: false } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(
      () => useChildChannelMeta("server-1", "post-1", true),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.isVerified).toBe(true))
    const trusted = rendered.result.current.data

    await queryClient.refetchQueries({
      queryKey: communityKeys.channelMeta("server-1", "post-1"),
      exact: true,
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    expect(rendered.result.current.data).toStrictEqual(trusted)
  })
})

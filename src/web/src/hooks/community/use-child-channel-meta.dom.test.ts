import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelSchema } from "@/lib/community-db/schema"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { useChannelMetadata } from "./use-channel-metadata"

const meta = (overrides: Partial<ReturnType<typeof channelSchema.parse>> = {}) => channelSchema.parse({
  id: "post-1", serverId: "server-1", name: "post", type: "thread",
  parentChannelId: "forum-1", parentMessageId: "opener-1", creatorId: "user-1",
  archived: false, lastMessageAt: "2026-08-09T00:00:00.000Z",
  position: 0, muted: false, unread: false, tags: [], pending: false, ...overrides,
})

async function fixture() {
  const { client } = await createCommunityQueryOwner()
  const registry = createCommunityDbRegistry(client, "viewer")
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  const rendered = renderHook(() => useChannelMetadata("server-1", "post-1"), { wrapper })
  return { client, registry, rendered }
}

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
  it("publishes every changed durable child metadata field through the common owner", async () => {
    const { client, rendered } = await fixture()
    await waitFor(() => expect(rendered.result.current.canRead).toBe(true))
    const changed = { name: "updated", parentChannelId: "forum-2", parentMessageId: "opener-2",
      creatorId: "user-2", lastMessageAt: "2026-08-10T00:00:00.000Z" }
    const response = await apiFetchMock.mock.results[0].value
    apiFetchMock.mockResolvedValue({ ...response, ...changed })
    await act(async () => client.refetchQueries({ queryKey: communityKeys.channelMeta("server-1", "post-1"), exact: true }))
    await waitFor(() => expect(rendered.result.current.data).toMatchObject(changed))
    expect(rendered.result.current.canRead).toBe(true)
    expect(rendered.result.current.data).toMatchObject({ id: "post-1", serverId: "server-1", type: "thread", archived: false })
    rendered.unmount()
  })

  it("keeps previously authorized child metadata readable across transport reconnect", async () => {
    const { registry, rendered } = await fixture()
    await waitFor(() => expect(rendered.result.current.canRead).toBe(true))
    const trusted = rendered.result.current.data
    act(() => registry.runtime.ws.actions.markAccessDisconnected())
    expect(rendered.result.current.canRead).toBe(true)
    expect(rendered.result.current.data).toBe(trusted)
    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.unmount()
  })

  it("does not publish an old first response that was never qualified", async () => {
    let resolve!: (value: unknown) => void
    apiFetchMock.mockReturnValue(new Promise((done) => { resolve = done }))
    const { client, registry, rendered } = await fixture()
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 })))
    await act(async () => resolve(meta()))
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({ name: "AbortError" }))
    expect(rendered.result.current.data).toBeUndefined()
    expect(rendered.result.current.canRead).toBe(false)
    expect(registry.collections.channels.get("post-1")).toBeUndefined()
    expect(client.getQueryData(communityKeys.channelMeta("server-1", "post-1"))).toBeUndefined()
    rendered.unmount()
  })

  it("authoritative archive retires a previously qualified child snapshot", async () => {
    const { client, registry, rendered } = await fixture()
    await waitFor(() => expect(rendered.result.current.canRead).toBe(true))
    apiFetchMock.mockResolvedValue({ ...meta(), archived: true })
    await act(async () => client.refetchQueries({ queryKey: communityKeys.channelMeta("server-1", "post-1"), exact: true }))
    await waitFor(() => expect(rendered.result.current.denied).toBe(true))
    expect(rendered.result.current.data).toBeUndefined()
    expect(rendered.result.current.canRead).toBe(false)
    expect(registry.collections.channels.get("post-1")).toBeUndefined()
    rendered.unmount()
  })

  it("starts exact metadata loading without waiting for the forum sidebar", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    renderHook(() => useChannelMetadata("server-1", "post-1"), { wrapper })

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
    const cached = meta()
    createCommunityDbRegistry(queryClient, "viewer").collections.channels.utils.writeUpsert(channelSchema.parse({
      ...cached, position: 0, muted: false, unread: false, tags: [], pending: false,
      lastMessageAt: cached.lastMessageAt,
    }))
    const rendered = renderHook(
      () => useChannelMetadata("server-1", "post-1"),
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
      () => useChannelMetadata("server-1", "post-1"),
      { wrapper },
    )

    expect(rendered.result.current).toMatchObject({
      data: { creatorId: null, lastMessageAt: null },
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
      () => useChannelMetadata("server-1", "post-1"),
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
      () => useChannelMetadata("server-1", "post-1"),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it("preserves the trusted fields and native Query when an exact refetch returns identical metadata", async () => {
    const { client: queryClient } = await createCommunityQueryOwner()
    queryClient.setDefaultOptions({ queries: { retry: false, structuralSharing: false } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(
      () => useChannelMetadata("server-1", "post-1"),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.isVerified).toBe(true))
    const trusted = rendered.result.current.data
    const resource = queryClient.getQueryCache().find({ queryKey: communityKeys.channelMeta("server-1", "post-1"), exact: true })

    await queryClient.refetchQueries({
      queryKey: communityKeys.channelMeta("server-1", "post-1"),
      exact: true,
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    expect({ ...rendered.result.current.data, identityProof: undefined, readProof: undefined })
      .toStrictEqual({ ...trusted, identityProof: undefined, readProof: undefined })
    expect(rendered.result.current.canRead).toBe(true)
    expect(queryClient.getQueryCache().find({ queryKey: communityKeys.channelMeta("server-1", "post-1"), exact: true })).toBe(resource)
  })
})

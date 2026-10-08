import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CONVERSATION_READ_TIMEOUT_MS } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"
import { channelMetadataOptions, fetchChannelMetadata } from "./channel-metadata"

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }))

const metadata = {
  id: "child", serverId: "server", type: "thread", name: "Child",
  parentChannelId: "parent", parentMessageId: "opener", creatorId: "owner",
  archived: 0, lastMessageAt: null, createdAt: "2026-09-05T00:00:00Z",
}

beforeEach(() => {
  fetchMock.mockReset()


})

describe("canonical channel metadata lifecycle", () => {
  it.each(["text", "forum", "thread", "dm"])("settles hanging %s metadata without publishing a late grant, then retries", async (type) => {
    const { client, runtime } = await createCommunityQueryOwner()
    const serverId = type === "dm" ? null : "server"
    const payload = { ...metadata, serverId, type, name: type === "dm" ? null : metadata.name }
    let release!: (value: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    vi.useFakeTimers()
    try {
      const options = channelMetadataOptions(client, serverId, "child")
      const result = client.query(options)
      const rejected = expect(result).rejects.toMatchObject({ name: "ConversationReadTimeoutError" })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      const readSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal
      await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
      await rejected
      expect(readSignal.aborted).toBe(true)
      release(payload)
      await Promise.resolve()
      await Promise.resolve()
      expect(runtime.ws.get().channelAccessScopes.has("child")).toBe(false)
      expect(client.getQueryData(options.queryKey)).toBeUndefined()
      fetchMock.mockResolvedValueOnce(payload)
      await expect(client.query(options)).resolves.toMatchObject({ id: "child" })
      expect(runtime.ws.get().channelAccessScopes.has("child")).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it("includes collection preload in the metadata deadline and never starts retired HTTP", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let release!: () => void
    vi.spyOn(registry.collections.channels, "preload").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    vi.useFakeTimers()
    try {
      const result = client.query(channelMetadataOptions(client, "server", "child"))
      const rejected = expect(result).rejects.toMatchObject({ name: "ConversationReadTimeoutError" })
      await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
      await rejected
      release()
      await Promise.resolve()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each(["text", "forum", "thread", "dm"])("validates the exact %s resource with its nullable scope", async (type) => {
    const serverId = type === "dm" ? null : "server"
    fetchMock.mockResolvedValue({ ...metadata, serverId, type, name: type === "dm" ? null : metadata.name })
    const { client, runtime } = await createCommunityQueryOwner()
    await expect(fetchChannelMetadata(client, serverId, "child")).resolves.toMatchObject({ id: "child", serverId, type, name: type === "dm" ? "" : metadata.name })
    expect(runtime.ws.get().channelAccessScopes.has("child")).toBe(true)
  })
  it.each(["account", "parent", "server", "membership"] as const)(
    "rejects an old successful HTTP response after %s changes",
    async (change) => {
      const { client, runtime } = await createCommunityQueryOwner()
      runtime.ws.actions.rememberChannelAccess("server", "child", "parent")
      let release!: (value: unknown) => void
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      const key = communityKeys.channelMeta("server", "child")
      const result = client.query({
        queryKey: key,
        queryFn: ({ signal }) => fetchChannelMetadata(client, "server", "child", signal),
      })
      const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      if (change === "account") {
        runtime.ws.actions.activateProfileAccount("bob")
        runtime.ws.actions.activateProfileAccount("alice")
      } else if (change === "parent") runtime.ws.actions.revokeChannelAccess("server", "parent")
      else if (change === "server") runtime.ws.actions.revokeServerAccess("server")
      else runtime.ws.actions.beginChannelMembershipChange("server", "child")
      const expectedScope = runtime.ws.get().channelAccessScopes.get("child")
      release(metadata)
      await rejection
      expect(client.getQueryData(key)).toBeUndefined()
      expect(runtime.ws.get().channelAccessScopes.get("child")).toEqual(expectedScope)
    },
  )

  it("accepts an authoritative HTTP response across a transport-only reconnect", async () => {
    let release!: (value: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const { client, runtime } = await createCommunityQueryOwner()
    const result = client.query({ queryKey: communityKeys.channelMeta("server", "child"), queryFn: ({ signal }) => fetchChannelMetadata(client, "server", "child", signal) })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const state = runtime.ws.actions
    const epoch = runtime.ws.get().accessEpoch
    state.markAccessConnected()
    state.markAccessDisconnected()
    state.markAccessConnected()
    release(metadata)
    await expect(result).resolves.toMatchObject({ id: "child", identityProof: expect.objectContaining({ accessEpoch: epoch }) })
  })

  it("restores readable child and parent only from a current authoritative response", async () => {
    const { client, runtime } = await createCommunityQueryOwner()
    const state = runtime.ws.actions
    state.revokeChannelAccess("server", "parent")
    state.revokeChannelAccess("server", "child")
    state.revokeServerAccess("server")
    fetchMock.mockResolvedValue(metadata)
    await expect(client.query({ queryKey: communityKeys.channelMeta("server", "child"), queryFn: ({ signal }) => fetchChannelMetadata(client, "server", "child", signal) })).resolves.toMatchObject({
      archived: false, activityAt: metadata.createdAt,
    })
    expect(runtime.ws.actions.isChannelAccessRevoked("child")).toBe(false)
    expect(runtime.ws.actions.isChannelAccessRevoked("parent")).toBe(false)
  })

  it.each([{ id: "other" }, { serverId: "other" }, { type: "unknown" }])(
    "does not grant access from mismatched metadata %j",
    async (overrides) => {
      const { client, runtime } = await createCommunityQueryOwner()
      runtime.ws.actions.revokeChannelAccess("server", "child")
      fetchMock.mockResolvedValue({ ...metadata, ...overrides })
      await expect(client.query({ queryKey: communityKeys.channelMeta("server", "child"), queryFn: ({ signal }) => fetchChannelMetadata(client, "server", "child", signal) })).rejects.toThrow(overrides.type ? "Invalid option" : "scope mismatch")
      expect(runtime.ws.actions.isChannelAccessRevoked("child")).toBe(true)
    },
  )
})

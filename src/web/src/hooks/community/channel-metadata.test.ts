import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import { fetchChannelMetadata } from "./channel-metadata"

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }))

const metadata = {
  id: "child", serverId: "server", type: "thread", name: "Child",
  parentChannelId: "parent", parentMessageId: "opener", creatorId: "owner",
  archived: 0, lastMessageAt: null, createdAt: "2026-09-05T00:00:00Z",
}

beforeEach(() => {
  fetchMock.mockReset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("alice")
})

describe("canonical channel metadata lifecycle", () => {
  it.each(["account", "parent", "server", "reconnect", "membership"] as const)(
    "rejects an old successful HTTP response after %s changes",
    async (change) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      let release!: (value: unknown) => void
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      const key = communityKeys.channelMeta("server", "child")
      const result = client.fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => fetchChannelMetadata("server", "child", signal),
      })
      const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
      const state = useCommunityWsStore.getState()
      if (change === "account") {
        state.activateProfileAccount("bob")
        useCommunityWsStore.getState().activateProfileAccount("alice")
      } else if (change === "parent") state.revokeChannelAccess("server", "parent")
      else if (change === "server") state.revokeServerAccess("server")
      else if (change === "membership") state.beginChannelMembershipChange("server", "child")
      else { state.markAccessDisconnected(); state.markAccessConnected() }
      release(metadata)
      await rejection
      expect(client.getQueryData(key)).toBeUndefined()
      expect(useCommunityWsStore.getState().channelAccessScopes.get("child")?.parentChannelId).toBeUndefined()
      client.clear()
    },
  )

  it("restores readable child and parent only from a current authoritative response", async () => {
    const state = useCommunityWsStore.getState()
    state.revokeChannelAccess("server", "parent")
    state.revokeChannelAccess("server", "child")
    state.revokeServerAccess("server")
    fetchMock.mockResolvedValue(metadata)
    await expect(fetchChannelMetadata("server", "child")).resolves.toMatchObject({
      archived: false, activityAt: metadata.createdAt,
    })
    expect(useCommunityWsStore.getState().isChannelAccessRevoked("child")).toBe(false)
    expect(useCommunityWsStore.getState().isChannelAccessRevoked("parent")).toBe(false)
  })

  it.each([{ id: "other" }, { serverId: "other" }, { type: "unknown" }])(
    "does not grant access from mismatched metadata %j",
    async (overrides) => {
      useCommunityWsStore.getState().revokeChannelAccess("server", "child")
      fetchMock.mockResolvedValue({ ...metadata, ...overrides })
      await expect(fetchChannelMetadata("server", "child")).rejects.toThrow("scope mismatch")
      expect(useCommunityWsStore.getState().isChannelAccessRevoked("child")).toBe(true)
    },
  )
})

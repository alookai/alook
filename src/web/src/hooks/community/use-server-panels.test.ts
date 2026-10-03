import { describe, it, expect, vi, beforeEach } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useInvites / invitesQueryFn", () => {
  it("materialises raw invite rows into InviteRow shape", async () => {
    apiFetchMock.mockResolvedValueOnce({
      invites: [
        {
          id: "inv_1",
          token: "abcd",
          maxUses: 10,
          uses: 3,
          expiresAt: null,
          createdAt: "2026-07-03T00:00:00.000Z",
          creatorId: "u_alice",
          creatorName: "Alice",
        },
      ],
    })
    const { invitesQueryFn } = await import("./use-server-panels")
    const { client: qc, registry } = await createCommunityQueryOwner()
    const data = await qc.fetchQuery({ queryKey: communityKeys.invites("srv_1"), queryFn: invitesQueryFn("srv_1") })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/invites", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(data.invites[0]).toEqual({
      code: "abcd",
      uses: 3,
      maxUses: 10,
      expiresAt: null,
      creatorId: "u_alice",
    })
    expect(registry.collections.profiles.get("u_alice")?.name).toBe("Alice")
  })

  it("populates queryClient at communityKeys.invites(serverId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ invites: [] })
    const { invitesQueryFn } = await import("./use-server-panels")
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.invites("srv_1")
    await qc.fetchQuery({ queryKey: key, queryFn: invitesQueryFn("srv_1") })
    expect(qc.getQueryData(key)).toEqual({ invites: [] })
  })
})

describe("usePresence / presenceQueryFn", () => {
  it("returns the online id list from the presence endpoint", async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ["u_1", "u_2"], truncated: false, limit: 1000 })
    const { presenceQueryFn } = await import("./use-server-panels")
    const { client: qc } = await createCommunityQueryOwner()
    const data = await qc.fetchQuery({ queryKey: communityKeys.presence("srv_1"), queryFn: presenceQueryFn("srv_1") })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/servers/srv_1/presence", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(data.online).toEqual(["u_1", "u_2"])
  })

  it("populates queryClient at communityKeys.presence(serverId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] })
    const { presenceQueryFn } = await import("./use-server-panels")
    const { client: qc } = await createCommunityQueryOwner()
    const key = communityKeys.presence("srv_1")
    await qc.fetchQuery({ queryKey: key, queryFn: presenceQueryFn("srv_1") })
    expect(qc.getQueryData(key)).toEqual({ online: [] })
  })
})

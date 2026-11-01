import { describe, expect, it, vi } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { profileResourceFixture } from "@/test/community-resource-fixtures"
import { communityUserProfilePatch, writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { friendsPresenceQueryFn } from "./use-friends"
import { presenceQueryFn } from "./use-server-panels"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const payload = (online: string[], offline: string[] = []) => ({ online, offline, truncated: false, limit: 1000 })

describe.each(["friends", "server"] as const)("%s presence publication", surface => {
  async function fixture() {
    apiFetch.mockReset()
    const owner = await createCommunityQueryOwner()
    for (const id of ["peer", "unconfirmed"]) {
      writeCommunityProfilePatches([communityUserProfilePatch(id, profileResourceFixture({ id, name: id }))], owner.registry)
      owner.runtime.ws.actions.setPresence(id, "online")
    }
    const queryKey = surface === "friends" ? communityKeys.friendsPresence() : communityKeys.presence("server")
    const queryFn = surface === "friends" ? friendsPresenceQueryFn : presenceQueryFn("server")
    return { ...owner, queryKey, queryFn }
  }

  it("keeps old values during the request and changes only explicitly confirmed ids", async () => {
    const f = await fixture(), response = deferred<ReturnType<typeof payload>>()
    apiFetch.mockReturnValueOnce(response.promise)
    const fetching = f.client.query({ queryKey: f.queryKey, queryFn: f.queryFn })
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    expect(f.registry.collections.profiles.get("peer")?.presence).toBe("online")
    response.resolve({ ...payload([], ["peer"]), truncated: true })
    await fetching
    expect(f.runtime.ws.get().presenceByUserId.get("peer")).toBe("offline")
    expect(f.registry.collections.profiles.get("peer")?.presence).toBe("offline")
    expect(f.registry.collections.profiles.get("unconfirmed")?.presence).toBe("online")
  })

  it("does not infer offline from a valid but empty or partial set of confirmed results", async () => {
    const f = await fixture()
    apiFetch.mockResolvedValueOnce(payload([]))
    await f.client.query({ queryKey: f.queryKey, queryFn: f.queryFn })
    expect(f.registry.collections.profiles.get("peer")?.presence).toBe("online")
  })

  it("does not roll a newer WebSocket update back when an old HTTP response arrives", async () => {
    const f = await fixture(), response = deferred<ReturnType<typeof payload>>()
    apiFetch.mockReturnValueOnce(response.promise)
    const fetching = f.client.query({ queryKey: f.queryKey, queryFn: f.queryFn })
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    f.runtime.ws.actions.setPresence("peer", "offline")
    response.resolve(payload(["peer"]))
    await fetching
    expect(f.registry.collections.profiles.get("peer")?.presence).toBe("offline")
  })

  it.each(["stale", "network", "invalid"])("preserves user facts after a %s read", async reason => {
    const f = await fixture()
    if (reason === "network") apiFetch.mockRejectedValueOnce(new Error("unavailable"))
    else apiFetch.mockResolvedValueOnce(reason === "stale" ? { ...payload([], ["peer"]), stale: true } : { ...payload(["peer"], ["peer"]) })
    await expect(f.client.query({ queryKey: f.queryKey, queryFn: f.queryFn })).rejects.toThrow()
    expect(f.registry.collections.profiles.get("peer")?.presence).toBe("online")
  })

  it.each(["cancel", "account", "permission"])("rejects a response after %s retirement", async reason => {
    const f = await fixture(), response = deferred<ReturnType<typeof payload>>()
    apiFetch.mockReturnValueOnce(response.promise)
    const fetching = f.client.query({ queryKey: f.queryKey, queryFn: f.queryFn }).then(() => undefined, error => error)
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce())
    if (reason === "cancel") await f.client.cancelQueries({ queryKey: f.queryKey, exact: true })
    else if (reason === "account") retireCommunityAccount(f.registry)
    else f.runtime.ws.actions.revokeServerAccess("server")
    response.resolve(payload([], ["peer"]))
    expect(await fetching).toBeTruthy()
    if (reason !== "account") expect(f.registry.collections.profiles.get("peer")?.presence).toBe("online")
    expect(f.runtime.ws.get().presenceByUserId.get("peer")).toBe("online")
  })
})

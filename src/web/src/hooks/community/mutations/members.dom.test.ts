import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { serverMembershipKey, profileSchema } from "@/lib/community-db/schema"
import { useSetMemberRole, useKickMember } from "./members"
import { useServerMembers } from "../use-server-members"
import { captureCommunityLiveSnapshotToken, publishCommunityMemberRole } from "@/lib/community-db/sync"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch, toastApiError: vi.fn() }))
beforeEach(() => { apiFetch.mockReset() })

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup(kind: "role" | "kick") {
  const owner = await createCommunityQueryOwner()
  const key = serverMembershipKey("srv_1", "u_1")
  const member = { id: "mem_1", userId: "u_1", role: "member", name: "n", discriminator: "0000", avatar: "N", status: "offline", sub: "" }
  owner.registry.collections.serverMemberships.utils.writeUpsert({ id: key, serverId: "srv_1", userId: "u_1", memberId: "mem_1", role: "member", viewer: false })
  owner.registry.collections.profiles.utils.writeUpsert(profileSchema.parse({ userId: "u_1", kind: "human", name: "n", discriminator: "0000", avatar: "N", avatarVersion: 0, presence: "offline" }))
  owner.client.setQueryData(communityKeys.members("srv_1"), { pages: [{ members: [{ id: "mem_1", userId: "u_1" }], hasMore: false, limit: 50, total: 1, liveRevision: 0 }], pageParams: [null] })
  const held = deferred()
  let remote = [member]
  apiFetch.mockImplementation((_path: string, options?: { method?: string }) => options?.method ? held.promise.then(() => { remote = kind === "role" ? [{ ...member, role: "admin" }] : [] }) : Promise.resolve({ members: remote, hasMore: false, limit: 50, total: remote.length }))
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const rendered = renderHook(() => ({ role: useSetMemberRole(), kick: useKickMember(), roster: useServerMembers("srv_1") }), { wrapper })
  await waitFor(() => expect(rendered.result.current.roster.members[0]?.role).toBe("member"))
  return { ...owner, key, held, rendered, confirmRemoteRole: (role: string) => { remote = remote.map((row) => ({ ...row, role })) } }
}

describe("Native member command canonical publication", () => {
  it("updates the canonical role optimistically and restores it on failure", async () => {
    const view = await setup("role")
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.role.mutateAsync({ serverId: "srv_1", memberId: "mem_1", role: "admin" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("admin"))
    await act(async () => { view.held.reject(new Error("boom")); await request })
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("member"))
    expect(view.client.getQueryData<{ pages: { members: unknown[] }[] }>(communityKeys.members("srv_1"))?.pages[0].members).toEqual([{ id: "mem_1", userId: "u_1" }])
  })

  it("publishes a role to the actual active search without a manual overlay bus", async () => {
    const view = await setup("role")
    act(() => view.rendered.result.current.roster.searchMembers("n"))
    await waitFor(() => expect(view.rendered.result.current.roster.searchStatus).toBe("ready"))
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.role.mutateAsync({ serverId: "srv_1", memberId: "mem_1", role: "admin" }) })
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("admin"))
    await act(async () => { view.held.resolve(); await request })
    expect(view.registry.collections.serverMemberships.get(view.key)?.role).toBe("admin")
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("admin"))
  })

  it("removes the canonical member optimistically and restores it on failure", async () => {
    const view = await setup("kick")
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.kick.mutateAsync({ serverId: "srv_1", memberId: "mem_1" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.roster.members).toEqual([]))
    await act(async () => { view.held.reject(new Error("boom")); await request })
    await waitFor(() => expect(view.rendered.result.current.roster.members).toHaveLength(1))
    expect(view.registry.collections.serverMemberships.get(view.key)?.memberId).toBe("mem_1")
  })

  it("publishes a confirmed kick to the actual active search without a manual overlay bus", async () => {
    const view = await setup("kick")
    act(() => view.rendered.result.current.roster.searchMembers("n"))
    await waitFor(() => expect(view.rendered.result.current.roster.searchStatus).toBe("ready"))
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.kick.mutateAsync({ serverId: "srv_1", memberId: "mem_1" }) })
    await waitFor(() => expect(view.rendered.result.current.roster.members).toEqual([]))
    await act(async () => { view.held.resolve(); await request })
    expect(view.registry.collections.serverMemberships.has(view.key)).toBe(false)
    expect(view.rendered.result.current.roster.members).toEqual([])
    expect(apiFetch).toHaveBeenCalledWith("/api/community/servers/srv_1/members/mem_1", expect.objectContaining({ method: "DELETE", authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
  })

  it("preserves a newer confirmed role through a failed optimistic role command", async () => {
    const view = await setup("role")
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.role.mutateAsync({ serverId: "srv_1", memberId: "mem_1", role: "admin" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("admin"))
    act(() => publishCommunityMemberRole(view.client, view.key, "mem_1", "owner", { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined }))
    view.confirmRemoteRole("owner")
    await act(async () => { view.held.reject(new Error("failed")); await request })
    await waitFor(() => expect(view.rendered.result.current.roster.members[0]?.role).toBe("owner"))
  })
})

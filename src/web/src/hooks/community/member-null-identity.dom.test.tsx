import { serverMembersReadFixture } from "@/test/community-resource-fixtures"
import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { useChannelMembers } from "./use-channel-members"
import { useServerMembers } from "./use-server-members"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => load(...args), toastApiError: vi.fn() }))
beforeEach(() => load.mockReset())

const profile = { id: "peer", name: "Peer", discriminator: null, avatar: null, avatarVersion: 3 }
const useChannel = () => useChannelMembers("channel", true, "server", "access")
const useServer = () => useServerMembers("server")
const member = { channelId: "channel", userId: "peer", relation: "access" as const, source: "explicit" as const,
  memberId: "member-peer", role: "member", isCreator: false }

describe("current nullable identity through actual member hooks", () => {
  it.each(["channel", "server"] as const)("completes the %s member read with a real NULL discriminator", async surface => {
    const owner = await createCommunityQueryOwner()
    load.mockResolvedValue(surface === "channel"
      ? { contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", relation: "access", members: [member], profiles: [profile] }
      : serverMembersReadFixture("server", [{ ...profile, id: member.memberId, userId: profile.id, role: "member", sub: "", status: "offline" }], { limit: 50 }))
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client }, children)
    const hook = renderHook(() => (surface === "channel" ? useChannel : useServer)(), { wrapper })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.failed).toBe(false)
    expect(hook.result.current.members).toEqual([expect.objectContaining({ userId: "peer", name: "Peer", discriminator: "" })])
    expect(owner.registry.collections.profiles.get("peer")).toMatchObject(profile)
    hook.unmount()
  })

  it.each(["channel", "server"] as const)("keeps a genuinely absent %s profile failed without a fake identity", async surface => {
    const owner = await createCommunityQueryOwner()
    owner.runtime.ws.actions.setPresence("peer", "online")
    expect(owner.runtime.ws.get().presenceByUserId.get("peer")).toBe("online")
    load.mockResolvedValue(surface === "channel"
      ? { contractVersion: BUSINESS_SCHEMA_VERSION, channelId: "channel", relation: "access", members: [member], profiles: [] }
      : { viewerId: "viewer", serverId: "server", members: [{ id: member.memberId, userId: profile.id, role: "member" }], hasMore: false, total: 1, limit: 50 })
    const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client }, children)
    const hook = renderHook(() => (surface === "channel" ? useChannel : useServer)(), { wrapper })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.failed).toBe(true)
    expect(owner.registry.collections.profiles.has("peer")).toBe(false)
    hook.unmount()
  })
})

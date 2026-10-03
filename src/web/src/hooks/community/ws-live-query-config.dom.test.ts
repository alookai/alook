import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { useInvites, usePresence } from "./use-server-panels"
import { useServer, useServers } from "./use-servers"
import { useServerMembers } from "./use-server-members"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
beforeEach(() => {
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/presence")) return { online: [] }
    if (path.endsWith("/invites")) return { invites: [] }
    if (path.includes("/members")) return { members: [], hasMore: false, limit: 100, total: 0 }
    if (path.endsWith("/categories")) return { categories: [] }
    if (path.endsWith("/channels")) return { channels: [] }
    return { servers: [{ id: "srv_1", name: "Server", discriminator: "0001", ownerId: "viewer", role: "owner", icon: null }] }
  })
})

async function setup(hook: () => unknown) {
  const owner = await createCommunityQueryOwner()
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const view = renderHook(hook, { wrapper })
  return { ...owner, view }
}

describe("Native WS-live query options", () => {
  it.each([
    ["presence", () => usePresence("srv_1"), communityKeys.presence("srv_1")],
    ["server detail", () => useServer("srv_1"), communityKeys.server("srv_1")],
    ["member roster", () => useServerMembers("srv_1"), communityKeys.members("srv_1")],
    ["server rail", () => useServers(), communityKeys.servers()],
  ] as const)("pairs infinite freshness with reconnect refresh for %s", async (_name, hook, key) => {
    const owner = await setup(hook)
    await waitFor(() => {
      const resource = owner.client.getQueryCache().find({ queryKey: key })
      expect(resource?.state.status).toBe("success")
      expect(resource?.options).toMatchObject({ staleTime: Infinity, refetchOnReconnect: true })
    })
  })

  it("keeps invite freshness finite on the physical Native Query", async () => {
    const owner = await setup(() => useInvites("srv_1", true))
    await waitFor(() => {
      const resource = owner.client.getQueryCache().find({ queryKey: communityKeys.invites("srv_1"), exact: true })
      expect(resource?.state.status).toBe("success")
      expect(resource?.options.staleTime).toBe(60_000)
      expect(resource?.options.staleTime).not.toBe(Infinity)
    })
  })
})

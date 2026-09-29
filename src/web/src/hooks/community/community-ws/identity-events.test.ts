import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import type { ProfileRow } from "@/lib/community-db/schema"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const cleanups: Array<() => Promise<void>> = []

async function harness() {
  const queryClient = new QueryClient()
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  const unregister = registerCommunityDbRegistry(registry)
  cleanups.push(async () => {
    unregister()
    await registry.cleanup()
    queryClient.clear()
  })
  return { queryClient, registry }
}

function profile(registry: ReturnType<typeof createCommunityDbRegistry>, userId: string) {
  return registry.collections.profiles.get(userId) as ProfileRow | undefined
}

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/community/servers") return { servers: [] }
    if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
    if (path === "/api/community/users/me/dms") return { conversations: [] }
    if (path === "/api/community/users/me/server-folders") return { folders: [] }
    if (path === "/api/community/users/me/notifications") return []
    if (path === "/api/community/users/me/attention") {
      return {
        scopes: [], items: [], limit: 100, truncated: false,
        included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
      }
    }
    throw new Error(`unexpected registry preload: ${path}`)
  })
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("profile identity events", () => {
  it("updates only the canonical avatar and leaves raw query snapshots untouched", async () => {
    const { queryClient, registry } = await harness()
    const cached = {
      id: "m1",
      authorId: "u1",
      authorAvatar: "/avatar?v=1",
      authorAvatarVersion: 1,
    }
    queryClient.setQueryData(communityKeys.message("m1"), cached)

    projectCommunityWsEventToDb(queryClient, {
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    })

    expect(queryClient.getQueryData(communityKeys.message("m1"))).toBe(cached)
    expect(profile(registry, "u1")).toMatchObject({
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    })
  })

  it("retains the current avatar for stale and equal-version conflicting frames", async () => {
    const { queryClient, registry } = await harness()
    projectCommunityWsEventToDb(queryClient, {
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    })
    projectCommunityWsEventToDb(queryClient, {
      type: "community:identity.update",
      userId: "u1",
      avatar: "/stale?v=4",
      avatarVersion: 4,
    })
    projectCommunityWsEventToDb(queryClient, {
      type: "community:identity.update",
      userId: "u1",
      avatar: "/conflict?v=5",
      avatarVersion: 5,
    })

    expect(profile(registry, "u1")).toMatchObject({
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    })
  })

  it("writes authoritative nullable profile fields to the canonical map", async () => {
    const { queryClient, registry } = await harness()
    projectCommunityWsEventToDb(queryClient, {
      type: "community:profile.update",
      userId: "bot-1",
      name: "Bot",
      discriminator: "0042",
      aboutMe: "",
      bannerColor: null,
      kind: "bot",
      ownerUserId: "owner-1",
    })

    expect(profile(registry, "bot-1")).toMatchObject({
      name: "Bot",
      discriminator: "0042",
      aboutMe: "",
      bannerColor: null,
      kind: "bot",
      ownerUserId: "owner-1",
    })
  })
})

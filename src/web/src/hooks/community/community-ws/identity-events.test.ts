import { beforeEach, describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import type { ProfileRow } from "@/lib/community-db/schema"

async function harness() {
  const queryClient = new QueryClient()
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  registerCommunityDbRegistry(registry)
  return { queryClient }
}

function profile(queryClient: QueryClient, userId: string) {
  return queryClient.getQueryData<ProfileRow[]>(
    communityKeys.communityDbCollection("viewer", "profiles"),
  )?.find((row) => row.userId === userId)
}

beforeEach(() => {
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("profile identity events", () => {
  it("updates only the canonical avatar and leaves raw query snapshots untouched", async () => {
    const { queryClient } = await harness()
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
    expect(profile(queryClient, "u1")).toMatchObject({
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    })
  })

  it("retains the current avatar for stale and equal-version conflicting frames", async () => {
    const { queryClient } = await harness()
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

    expect(profile(queryClient, "u1")).toMatchObject({
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    })
  })

  it("writes authoritative nullable profile fields to the canonical map", async () => {
    const { queryClient } = await harness()
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

    expect(profile(queryClient, "bot-1")).toMatchObject({
      name: "Bot",
      discriminator: "0042",
      aboutMe: "",
      bannerColor: null,
      kind: "bot",
      ownerUserId: "owner-1",
    })
  })
})

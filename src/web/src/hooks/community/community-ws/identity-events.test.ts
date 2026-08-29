import { beforeEach, describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { CommunityWsHandlerContext } from "./handler-context"
import { handleIdentityUpdate, handleProfileUpdate } from "./identity-events"

function harness() {
  const queryClient = new QueryClient()
  return {
    queryClient,
    context: {
      queryClient,
      wsStore: useCommunityWsStore.getState(),
    } as unknown as CommunityWsHandlerContext,
  }
}

beforeEach(() => {
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("profile identity events", () => {
  it("updates only the canonical avatar and leaves raw query snapshots untouched", () => {
    const { queryClient, context } = harness()
    const cached = {
      id: "m1",
      authorId: "u1",
      authorAvatar: "/avatar?v=1",
      authorAvatarVersion: 1,
    }
    queryClient.setQueryData(communityKeys.message("m1"), cached)

    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    }, context)

    expect(queryClient.getQueryData(communityKeys.message("m1"))).toBe(cached)
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    })
  })

  it("retains the current avatar for stale and equal-version conflicting frames", () => {
    const { context } = harness()
    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    }, context)
    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/stale?v=4",
      avatarVersion: 4,
    }, context)
    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/conflict?v=5",
      avatarVersion: 5,
    }, context)

    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    })
  })

  it("writes authoritative nullable profile fields to the canonical map", () => {
    const { context } = harness()
    handleProfileUpdate({
      type: "community:profile.update",
      userId: "bot-1",
      name: "Bot",
      discriminator: "0042",
      aboutMe: "",
      bannerColor: null,
      kind: "bot",
      ownerUserId: "owner-1",
    }, context)

    expect(useCommunityWsStore.getState().profilesByUserId.get("bot-1")).toMatchObject({
      name: "Bot",
      discriminator: "0042",
      aboutMe: "",
      bannerColor: null,
      kind: "bot",
      ownerUserId: "owner-1",
    })
  })
})

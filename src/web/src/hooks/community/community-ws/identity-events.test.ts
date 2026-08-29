import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { CommunityWsHandlerContext } from "./handler-context"
import { handleIdentityUpdate } from "./identity-events"

function harness() {
  const queryClient = new QueryClient()
  const invalidate = vi.fn()
  const context = {
    queryClient,
    wsStore: useCommunityWsStore.getState(),
    projection: {
      project: (project: () => void) => project(),
      invalidate,
    },
  } as unknown as CommunityWsHandlerContext
  return { queryClient, invalidate, context }
}

beforeEach(() => {
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().bindIdentityOwner("viewer")
  useMessageStreamStore.getState().resetAll()
})

describe("handleIdentityUpdate", () => {
  it("patches all cached projections and the detached message stream", () => {
    const { queryClient, context, invalidate } = harness()
    queryClient.setQueryData(communityKeys.message("m1"), {
      id: "m1",
      authorId: "u1",
      authorAvatar: "/avatar?v=1",
      authorAvatarVersion: 1,
    })
    const projectStream = vi.spyOn(
      useMessageStreamStore.getState(),
      "projectAvatarIdentity",
    )

    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    }, context)

    expect(queryClient.getQueryData(communityKeys.message("m1"))).toMatchObject({
      authorAvatar: "/avatar?v=4",
      authorAvatarVersion: 4,
    })
    expect(projectStream).toHaveBeenCalledWith("u1", "/avatar?v=4", 4)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("drops stale/same frames and invalidates a same-version conflict", () => {
    const { context, invalidate } = harness()
    const store = useCommunityWsStore.getState()
    store.observeAvatarIdentity("u1", "/avatar?v=5", 5)

    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=4",
      avatarVersion: 4,
    }, context)
    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/avatar?v=5",
      avatarVersion: 5,
    }, context)
    expect(invalidate).not.toHaveBeenCalled()

    handleIdentityUpdate({
      type: "community:identity.update",
      userId: "u1",
      avatar: "/different?v=5",
      avatarVersion: 5,
    }, context)
    expect(invalidate).toHaveBeenCalledWith("identity-conflict", {
      queryKey: communityKeys.all,
      refetchType: "active",
    })
  })
})

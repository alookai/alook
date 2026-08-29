import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityWsStore } from "@/stores/community/ws"
import { projectIdentityPayload } from "./identity-projection"

beforeEach(() => {
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().bindIdentityOwner("viewer-a")
})

describe("projectIdentityPayload", () => {
  it("uses a two-pass observation so a newer row later in one payload upgrades every copy", () => {
    const untouched = { kind: "sentinel" }
    const payload = {
      rows: [
        { userId: "u1", avatar: "/avatar?v=2", avatarVersion: 2 },
        { userId: "u1", avatar: "/avatar?v=5", avatarVersion: 5 },
      ],
      untouched,
    }

    const projected = projectIdentityPayload(payload)

    expect(projected.rows).toEqual([
      { userId: "u1", avatar: "/avatar?v=5", avatarVersion: 5 },
      { userId: "u1", avatar: "/avatar?v=5", avatarVersion: 5 },
    ])
    expect(projected.untouched).toBe(untouched)
    expect(useCommunityWsStore.getState().avatarIdentities.get("u1"))
      .toEqual({ avatar: "/avatar?v=5", avatarVersion: 5 })
  })

  it("projects every supported nested identity slot without mutating the input", () => {
    useCommunityWsStore.getState().observeAvatarIdentity("author", "/author?v=7", 7)
    useCommunityWsStore.getState().observeAvatarIdentity("peer", "/peer?v=6", 6)
    useCommunityWsStore.getState().observeAvatarIdentity("creator", "/creator?v=5", 5)
    const payload = {
      message: {
        authorId: "author",
        authorAvatar: "/author?v=1",
        authorAvatarVersion: 1,
      },
      dm: {
        otherUserId: "peer",
        otherUserAvatar: "/peer?v=1",
        otherUserAvatarVersion: 1,
      },
      forum: {
        creatorId: "creator",
        creatorAvatar: "/creator?v=1",
        creatorAvatarVersion: 1,
      },
    }

    const projected = projectIdentityPayload(payload)

    expect(projected).not.toBe(payload)
    expect(projected.message).toMatchObject({ authorAvatar: "/author?v=7", authorAvatarVersion: 7 })
    expect(projected.dm).toMatchObject({ otherUserAvatar: "/peer?v=6", otherUserAvatarVersion: 6 })
    expect(projected.forum).toMatchObject({ creatorAvatar: "/creator?v=5", creatorAvatarVersion: 5 })
    expect(payload.message.authorAvatar).toBe("/author?v=1")
  })

  it("fences delayed stale HTTP and reports a same-version URL conflict", () => {
    projectIdentityPayload({ id: "u1", image: "/avatar?v=9", avatarVersion: 9 })
    const conflict = vi.fn()

    const stale = projectIdentityPayload(
      { id: "u1", image: "/avatar?v=4", avatarVersion: 4 },
      conflict,
    )
    expect(stale).toEqual({ id: "u1", image: "/avatar?v=9", avatarVersion: 9 })
    expect(conflict).not.toHaveBeenCalled()

    const divergent = projectIdentityPayload(
      { id: "u1", image: "/other?v=9", avatarVersion: 9 },
      conflict,
    )
    expect(divergent).toEqual({ id: "u1", image: "/avatar?v=9", avatarVersion: 9 })
    expect(conflict).toHaveBeenCalledWith("u1")
  })

  it("does not carry an identity fence across account changes", () => {
    projectIdentityPayload({ userId: "u1", avatar: "/avatar?v=8", avatarVersion: 8 })
    useCommunityWsStore.getState().bindIdentityOwner("viewer-b")

    const projected = projectIdentityPayload({
      userId: "u1",
      avatar: "/avatar?v=1",
      avatarVersion: 1,
    })

    expect(projected.avatar).toBe("/avatar?v=1")
    expect(useCommunityWsStore.getState().avatarIdentities.get("u1"))
      .toEqual({ avatar: "/avatar?v=1", avatarVersion: 1 })
  })
})

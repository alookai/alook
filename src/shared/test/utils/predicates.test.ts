import { describe, it, expect } from "vitest"
import { isForum, isForumPost, isThread, canManageServer } from "../../src/utils/community-roles"
import { isPresenceOnline, isPresenceOffline } from "../../src/utils/status"
import { isAccepted, isPending, isBlocked } from "../../src/utils/friendship"
import { isPublic, isPrivate } from "../../src/utils/visibility"

describe("channel-type predicates", () => {
  it("isForum", () => {
    expect(isForum("forum")).toBe(true)
    expect(isForum("forum_post")).toBe(false)
    expect(isForum("text")).toBe(false)
    expect(isForum(null)).toBe(false)
    expect(isForum(undefined)).toBe(false)
  })
  it("isForumPost", () => {
    expect(isForumPost("forum_post")).toBe(true)
    expect(isForumPost("forum")).toBe(false)
    expect(isForumPost(null)).toBe(false)
  })
  it("isThread", () => {
    expect(isThread("thread")).toBe(true)
    expect(isThread("text")).toBe(false)
    expect(isThread(undefined)).toBe(false)
  })
})

describe("canManageServer matches old role === owner || admin", () => {
  const roles = ["owner", "admin", "member", "guest", "", null, undefined]
  for (const role of roles) {
    it(`role=${String(role)}`, () => {
      const expected = role === "owner" || role === "admin"
      expect(canManageServer(role)).toBe(expected)
    })
  }
})

describe("presence-string predicates", () => {
  it("isPresenceOnline", () => {
    expect(isPresenceOnline("online")).toBe(true)
    expect(isPresenceOnline("offline")).toBe(false)
    expect(isPresenceOnline(null)).toBe(false)
    expect(isPresenceOnline(undefined)).toBe(false)
  })
  it("isPresenceOffline", () => {
    expect(isPresenceOffline("offline")).toBe(true)
    expect(isPresenceOffline("online")).toBe(false)
    expect(isPresenceOffline(null)).toBe(false)
  })
})

describe("friendship-status predicates", () => {
  it("isAccepted", () => {
    expect(isAccepted("accepted")).toBe(true)
    expect(isAccepted("pending")).toBe(false)
    expect(isAccepted(null)).toBe(false)
  })
  it("isPending", () => {
    expect(isPending("pending")).toBe(true)
    expect(isPending("accepted")).toBe(false)
  })
  it("isBlocked", () => {
    expect(isBlocked("blocked")).toBe(true)
    expect(isBlocked("accepted")).toBe(false)
  })
})

describe("visibility predicates", () => {
  it("isPublic", () => {
    expect(isPublic("public")).toBe(true)
    expect(isPublic("private")).toBe(false)
    expect(isPublic(null)).toBe(false)
  })
  it("isPrivate", () => {
    expect(isPrivate("private")).toBe(true)
    expect(isPrivate("public")).toBe(false)
    expect(isPrivate(undefined)).toBe(false)
  })
})

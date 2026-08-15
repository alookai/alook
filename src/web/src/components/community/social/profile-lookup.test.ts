import { describe, it, expect } from "vitest"
import {
  resolveProfileContextLabel,
  resolveProfileServerId,
  resolveProfileTarget,
  resolveProfileUserId,
  buildSelfProfile,
} from "./profile-lookup"
import type { Member, Friend } from "@/lib/community/models/people"
import type { CurrentUser } from "@/contexts/community/current-user"

function member(overrides: Partial<Member>): Member {
  return {
    id: overrides.id ?? "mem_default",
    userId: overrides.userId ?? "user_default",
    name: overrides.name ?? "Default",
    discriminator: overrides.discriminator ?? "0000",
    avatar: overrides.avatar ?? "D",
    status: overrides.status ?? "online",
    sub: overrides.sub ?? "",
    role: overrides.role ?? "member",
  }
}

describe("resolveProfileTarget", () => {
  it("resolves the exact member by userId when two members share a name — regression for the bug where profile cards collapsed to the first name match", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "435669237", discriminator: "7892" })
    const b = member({ id: "mem_b", userId: "user_b", name: "435669237", discriminator: "3759" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "435669237", userId: "user_b" })).toBe(b)
    expect(resolveProfileTarget(members, undefined, { name: "435669237", userId: "user_a" })).toBe(a)
  })

  it("falls back to discriminator matching when no userId is available (mention pill case)", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "Gus", discriminator: "0042" })
    const b = member({ id: "mem_b", userId: "user_b", name: "Gus", discriminator: "0099" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "Gus", discriminator: "0099" })).toBe(b)
  })

  it("falls back to the first name match when neither userId nor discriminator is provided (legacy behavior)", () => {
    const a = member({ id: "mem_a", userId: "user_a", name: "Gus" })
    const b = member({ id: "mem_b", userId: "user_b", name: "Gus" })
    const members = [a, b]

    expect(resolveProfileTarget(members, undefined, { name: "Gus" })).toBe(a)
  })

  it("checks friends when userId doesn't match any member", () => {
    const friend: Friend = { id: "fr_a", userId: "user_c", name: "Ren", discriminator: "0000", avatar: "R", status: "online", sub: "" }
    expect(resolveProfileTarget([], [friend], { name: "Ren", userId: "user_c" })).toBe(friend)
  })
})

describe("profile context", () => {
  it("uses the shell view as the synchronous context boundary", () => {
    expect(resolveProfileServerId("server", "server_1")).toBe("server_1")
    expect(resolveProfileServerId("dm", "stale_server")).toBeNull()
    expect(resolveProfileServerId("settings", "stale_server")).toBeNull()
  })

  it.each([
    ["owner", "Owner"],
    ["admin", "Admin"],
    ["member", "Member"],
  ] as const)("shows the real %s role only in a server", (role, label) => {
    const target = member({ role })

    expect(resolveProfileContextLabel("server_1", target)).toBe(label)
    expect(resolveProfileContextLabel(null, target)).toBeUndefined()
  })

  it("does not turn a friend row into a server member badge", () => {
    const friend: Friend = { id: "friend_1", userId: "user_1", name: "Ren", discriminator: "0001", avatar: "R", status: "online", sub: "" }

    expect(resolveProfileContextLabel("server_1", friend)).toBeUndefined()
  })

  it("keeps the caller user id when no cached member or friend resolves", () => {
    expect(resolveProfileUserId(undefined, "user_uncached")).toBe("user_uncached")
  })

  it("prefers the resolved row user id over the caller fallback", () => {
    expect(resolveProfileUserId(member({ userId: "user_resolved" }), "user_fallback"))
      .toBe("user_resolved")
  })
})

function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: overrides.id ?? "user_self",
    name: overrides.name ?? "Me",
    email: overrides.email ?? "me@example.com",
    avatar: overrides.avatar ?? "M",
    aboutMe: overrides.aboutMe,
    discriminator: overrides.discriminator,
    statusEmoji: overrides.statusEmoji,
    statusText: overrides.statusText,
  }
}

describe("buildSelfProfile", () => {
  it("builds the viewer's own card from currentUser, independent of any member/friend list — regression for the /c/me UserBar bug where a same-named friend was shown instead of the viewer", () => {
    const me = currentUser({ id: "user_self", name: "Ren", discriminator: "0001", aboutMe: "hi" })
    const profile = buildSelfProfile(me, new Set())

    expect(profile.userId).toBe("user_self")
    expect(profile.name).toBe("Ren")
    expect(profile.discriminator).toBe("0001")
    expect(profile.about).toBe("hi")
    expect(profile.contextLabel).toBeUndefined()
  })

  it("always resolves self presence to online, even when the viewer's id is absent from the online set", () => {
    const profile = buildSelfProfile(currentUser({ id: "user_self" }), new Set())
    expect(profile.presence).toBe("online")
  })

  it("falls back to an avatar initial when the viewer has no avatar", () => {
    const profile = buildSelfProfile(currentUser({ name: "alice", avatar: "" }), new Set())
    expect(profile.avatar).toBe("A")
  })

  it("uses the viewer's real server role when the caller provides one", () => {
    const profile = buildSelfProfile(currentUser(), new Set(), "Admin")

    expect(profile.contextLabel).toBe("Admin")
  })
})

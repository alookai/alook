import { describe, it, expect } from "vitest"
import { mapMemberForApi, type MemberRow } from "./member-payload"

function row(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    id: "m1",
    userId: "u1",
    role: "member",
    nickname: null,
    userName: "Ann",
    userImage: null,
    discriminator: "0001",
    statusEmoji: null,
    statusText: null,
    ...overrides,
  }
}

describe("mapMemberForApi", () => {
  it("produces the canonical display shape with sub, defaults, and nickname fallback", () => {
    const m = mapMemberForApi(row({ nickname: "Annie" }), "viewer")
    expect(m).toMatchObject({
      id: "m1",
      userId: "u1",
      name: "Annie", // nickname wins over userName
      discriminator: "0001",
      status: "offline",
      sub: "",
      role: "member",
      statusEmoji: null,
      statusText: "",
    })
    // No opt-in flags → no isCreator/source/isBot fields.
    expect("isCreator" in m).toBe(false)
    expect("source" in m).toBe(false)
    expect("isBot" in m).toBe(false)
  })

  it("marks the viewer's own row online", () => {
    expect(mapMemberForApi(row({ userId: "viewer" }), "viewer").status).toBe("online")
  })

  it("falls back to userName then avatarInitial when nickname/image absent", () => {
    const m = mapMemberForApi(row({ nickname: null, userName: "Zed", userImage: null }), "viewer")
    expect(m.name).toBe("Zed")
    expect(m.avatar).toBeTruthy()
  })

  it("botGating exposes isBot/ownerUserId only on the viewer's own bot", () => {
    const own = mapMemberForApi(
      row({ userId: "b1", userIsBot: true, userOwnerUserId: "viewer" }),
      "viewer",
      { botGating: true },
    )
    expect(own.isBot).toBe(true)
    expect(own.ownerUserId).toBe("viewer")

    const other = mapMemberForApi(
      row({ userId: "b2", userIsBot: true, userOwnerUserId: "someone_else" }),
      "viewer",
      { botGating: true },
    )
    expect(other.isBot).toBeUndefined()
    expect(other.ownerUserId).toBeUndefined()
  })

  it("without botGating, never emits isBot even for an own bot (search parity)", () => {
    const m = mapMemberForApi(
      row({ userId: "b1", userIsBot: true, userOwnerUserId: "viewer" }),
      "viewer",
    )
    expect(m.isBot).toBeUndefined()
    expect(m.ownerUserId).toBeUndefined()
  })

  it("passes through isCreator and source when provided", () => {
    const m = mapMemberForApi(row(), "viewer", { isCreator: true, source: "explicit" })
    expect(m.isCreator).toBe(true)
    expect(m.source).toBe("explicit")
  })
})

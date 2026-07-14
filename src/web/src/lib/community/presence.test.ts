import { describe, it, expect } from "vitest"
import { resolveProfilePresence, resolveRowPresence } from "./presence"

describe("resolveProfilePresence", () => {
  it("returns online for self regardless of onlineUserIds", () => {
    expect(resolveProfilePresence(true, undefined, new Set())).toBe("online")
    expect(resolveProfilePresence(true, "u1", new Set())).toBe("online")
  })

  it("returns online when targetUserId is in onlineUserIds", () => {
    expect(resolveProfilePresence(false, "u1", new Set(["u1", "u2"]))).toBe("online")
  })

  it("returns offline when targetUserId is resolved but not online", () => {
    expect(resolveProfilePresence(false, "u3", new Set(["u1", "u2"]))).toBe("offline")
  })

  it("returns undefined when targetUserId is undefined (no member/friend match)", () => {
    expect(resolveProfilePresence(false, undefined, new Set(["u1"]))).toBeUndefined()
  })
})

describe("resolveRowPresence", () => {
  it("returns online for the current user regardless of the online set", () => {
    expect(resolveRowPresence({ userId: "me" }, new Set(), "me")).toBe("online")
    expect(resolveRowPresence({ id: "me" }, new Set(), "me")).toBe("online")
  })

  it("returns online when the resolved id is in onlineUserIds", () => {
    expect(resolveRowPresence({ userId: "u1" }, new Set(["u1"]))).toBe("online")
  })

  it("returns offline when the resolved id is not online", () => {
    expect(resolveRowPresence({ userId: "u2" }, new Set(["u1"]))).toBe("offline")
  })

  it("normalizes the key as userId ?? id", () => {
    // userId wins when both present
    expect(resolveRowPresence({ userId: "u1", id: "other" }, new Set(["u1"]))).toBe("online")
    expect(resolveRowPresence({ userId: "u1", id: "other" }, new Set(["other"]))).toBe("offline")
    // falls back to id when userId is absent/nullish
    expect(resolveRowPresence({ id: "f1" }, new Set(["f1"]))).toBe("online")
    expect(resolveRowPresence({ userId: null, id: "f1" }, new Set(["f1"]))).toBe("online")
  })

  it("returns offline (never undefined) when no id resolves", () => {
    expect(resolveRowPresence({}, new Set(["u1"]))).toBe("offline")
    expect(resolveRowPresence({ userId: null, id: null }, new Set())).toBe("offline")
  })
})

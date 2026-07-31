import { describe, it, expect } from "vitest"
import { compactLabel, describeRefTokenPillView } from "./ref-token-pill"

describe("compactLabel", () => {
  it("takes the last path segment", () => {
    expect(compactLabel("/Alook/general")).toBe("general")
    expect(compactLabel("/Alook/general#42")).toBe("general#42")
    expect(compactLabel("/Alook")).toBe("Alook")
  })

  it("ignores a trailing slash", () => {
    expect(compactLabel("/Alook/general/")).toBe("general")
  })

  it("falls back to the whole label when there is no segment", () => {
    expect(compactLabel("plain")).toBe("plain")
  })
})

describe("describeRefTokenPillView (hybrid: live name preferred, label fallback)", () => {
  it("channel: uses the live name + owning server when resolved", () => {
    expect(
      describeRefTokenPillView({
        refType: "channel",
        id: "c1",
        label: "/Alook/old-name",
        liveName: "new-name",
        channelServerId: "s1",
      }),
    ).toEqual({ kind: "channel", label: "new-name", serverId: "s1", channelId: "c1" })
  })

  it("channel: falls back to the compact stored label when unresolved (renders, doesn't navigate)", () => {
    // Deleted / no-access / directory not loaded → no liveName, no serverId.
    expect(
      describeRefTokenPillView({
        refType: "channel",
        id: "c_gone",
        label: "/Alook/general",
        liveName: null,
        channelServerId: null,
      }),
    ).toEqual({ kind: "message", label: "general" })
  })

  it("server: live name when resolved, compact label otherwise", () => {
    expect(
      describeRefTokenPillView({ refType: "server", id: "s1", label: "/Alook", liveName: "Alook Renamed", channelServerId: null }),
    ).toEqual({ kind: "server", label: "Alook Renamed", serverId: "s1" })
    expect(
      describeRefTokenPillView({ refType: "server", id: "s_gone", label: "/Alook", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "server", label: "Alook", serverId: "s_gone" })
  })

  it("message: readable non-navigating pill from the compact label (no channelId+seq to jump)", () => {
    expect(
      describeRefTokenPillView({ refType: "message", id: "m1", label: "/Alook/general#42", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general#42" })
  })
})

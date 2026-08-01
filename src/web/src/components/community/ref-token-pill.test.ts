import { describe, it, expect } from "vitest"
import { compactLabel, describeRefTokenPillView, resolveMessageJump } from "./ref-token-pill"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"

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
    // Lands in the readable non-navigating (`message`-kind) branch with seq=null.
    expect(
      describeRefTokenPillView({
        refType: "channel",
        id: "c_gone",
        label: "/Alook/general",
        liveName: null,
        channelServerId: null,
      }),
    ).toEqual({ kind: "message", label: "general", seq: null })
  })

  it("server: live name when resolved, compact label otherwise", () => {
    expect(
      describeRefTokenPillView({ refType: "server", id: "s1", label: "/Alook", liveName: "Alook Renamed", channelServerId: null }),
    ).toEqual({ kind: "server", label: "Alook Renamed", serverId: "s1" })
    expect(
      describeRefTokenPillView({ refType: "server", id: "s_gone", label: "/Alook", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "server", label: "Alook", serverId: "s_gone" })
  })

  it("message: channel leaf + seq from the label (renders `general #42`) — parsed via parseRef, single source with the preview", () => {
    expect(
      describeRefTokenPillView({ refType: "message", id: "m1", label: "/Alook/general#42", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: 42 })
  })

  it("message: thread-message label /#5#42 yields the reply seq 42, not the thread root", () => {
    expect(
      describeRefTokenPillView({ refType: "message", id: "m2", label: "/Alook/general/#5#42", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: 42 })
  })

  it("message: a label with no seq degrades to leaf + null seq (no fabricated seq)", () => {
    expect(
      describeRefTokenPillView({ refType: "message", id: "m3", label: "/Alook/general", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: null })
  })
})

describe("resolveMessageJump (ref/id A2 — message pill → context-sheet target)", () => {
  const directory: ChannelRefDirectory = [
    { id: "s_alook", name: "Alook", channels: [{ id: "c_general", name: "general" }, { id: "c_ideas", name: "ideas" }] },
    { id: "s_other", name: "Other", channels: [{ id: "c_x", name: "general" }] },
  ]

  it("resolves a /server/channel#seq label to {serverId, channelId, label, seq} by name", () => {
    expect(resolveMessageJump("/Alook/general#42", directory)).toEqual({
      serverId: "s_alook", channelId: "c_general", label: "general", seq: 42,
    })
  })

  it("returns null for a thread-message label (/#5#42) — a thread's seq space isn't in the top-level directory, so it can't jump correctly (Ingaborg #337)", () => {
    expect(resolveMessageJump("/Alook/ideas/#5#42", directory)).toBeNull()
  })

  it("returns null when the label has no seq (nothing to jump to)", () => {
    expect(resolveMessageJump("/Alook/general", directory)).toBeNull()
  })

  it("returns null when the server or channel isn't in the directory (deleted / no access)", () => {
    expect(resolveMessageJump("/Ghost/general#1", directory)).toBeNull()
    expect(resolveMessageJump("/Alook/ghost#1", directory)).toBeNull()
  })

  it("returns null on an unparseable label rather than throwing", () => {
    expect(resolveMessageJump("not-a-ref", directory)).toBeNull()
  })
})

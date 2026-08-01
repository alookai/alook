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

  it("message pin (channel token, label #seq) renders `general #42` — leaf + display seq from label", () => {
    expect(
      describeRefTokenPillView({ refType: "channel", id: "c_general", label: "/Alook/general#42", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: 42 })
  })

  it("thread message DISPLAY shows the ROOT seq #5 (human anchor), not the thread-internal #42 (#3, Faustine #332)", () => {
    // Display axis = root N; the JUMP axis (resolveMessageJump) separately uses M=42.
    expect(
      describeRefTokenPillView({ refType: "channel", id: "tid_thread", label: "/Alook/general/#5#42", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: 5 })
  })

  it("channel token with a seq-less label + no owning server → readable non-navigating (message kind, null seq)", () => {
    expect(
      describeRefTokenPillView({ refType: "channel", id: "c_x", label: "/Alook/general", liveName: null, channelServerId: null }),
    ).toEqual({ kind: "message", label: "general", seq: null })
  })
})

describe("resolveMessageJump (ref/id A2 + #3 — message pill → context-sheet target)", () => {
  const directory: ChannelRefDirectory = [
    { id: "s_alook", name: "Alook", channels: [{ id: "c_general", name: "general" }, { id: "c_ideas", name: "ideas" }] },
    { id: "s_other", name: "Other", channels: [{ id: "c_x", name: "general" }] },
  ]

  it("channelId = the token id (leaf) DIRECTLY, serverId from the label server-seg via directory", () => {
    // The `()` id is the leaf channel the message lives in; used directly, not a
    // directory channel lookup. serverId still resolved from the label's server.
    expect(resolveMessageJump("/Alook/general#42", "c_general", directory)).toEqual({
      serverId: "s_alook", channelId: "c_general", label: "general", seq: 42,
    })
  })

  it("thread-message (/#5#42) JUMPS to the thread's own channelId (the token id = tid) + reply seq M=42 (#3)", () => {
    // #3: a thread message's `()` id is the thread's OWN channelId (tid). The
    // jump uses tid directly + the thread-internal seq M (parsed.seq=42), NOT
    // the root #N (5) which is only the human display anchor. tid need not be in
    // the directory — channelId comes from the id arg, only serverId uses the dir.
    expect(resolveMessageJump("/Alook/ideas/#5#42", "tid_thread", directory)).toEqual({
      serverId: "s_alook", channelId: "tid_thread", label: "ideas", seq: 42,
    })
  })

  it("returns null when the label has no seq (a plain channel ref → navigate, not context-jump)", () => {
    expect(resolveMessageJump("/Alook/general", "c_general", directory)).toBeNull()
  })

  it("returns null when the label's server isn't in the directory (renamed / no access)", () => {
    expect(resolveMessageJump("/Ghost/general#1", "c_whatever", directory)).toBeNull()
  })

  it("jumps even when the label's channel name is unknown to the directory — channelId is the token id, not a name lookup (#3)", () => {
    // A thread tid (or a renamed channel) whose name isn't in the directory still
    // jumps: only the SERVER must resolve; channelId is the id arg directly.
    expect(resolveMessageJump("/Alook/ghost#1", "tid_or_renamed", directory)).toEqual({
      serverId: "s_alook", channelId: "tid_or_renamed", label: "ghost", seq: 1,
    })
  })

  it("returns null on an unparseable label rather than throwing", () => {
    expect(resolveMessageJump("not-a-ref", "x", directory)).toBeNull()
  })
})

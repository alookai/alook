import { describe, it, expect } from "vitest"
import { resolveChannelRefBase, type ChannelRefDirectory } from "./channel-ref"

const directory: ChannelRefDirectory = [
  {
    id: "srv_studio",
    name: "studio",
    channels: [
      { id: "chn_general", name: "general" },
      { id: "chn_random", name: "random" },
    ],
  },
  {
    id: "srv_other",
    name: "other",
    channels: [{ id: "chn_dup", name: "general" }],
  },
]

describe("resolveChannelRefBase", () => {
  it("resolves a `<#serverId:channelId>` token by id for both segments", () => {
    const resolved = resolveChannelRefBase(directory, "<#srv_studio:chn_general>")
    expect(resolved?.server.id).toBe("srv_studio")
    expect(resolved?.channel.id).toBe("chn_general")
  })

  it("resolves a cross-server token", () => {
    const resolved = resolveChannelRefBase(directory, "<#srv_other:chn_dup>")
    expect(resolved?.server.id).toBe("srv_other")
    expect(resolved?.channel.id).toBe("chn_dup")
  })

  it("returns null when the server isn't in the directory", () => {
    expect(resolveChannelRefBase(directory, "<#srv_nope:chn_general>")).toBeNull()
  })

  it("returns null when the channel isn't in the resolved server", () => {
    expect(resolveChannelRefBase(directory, "<#srv_studio:chn_nope>")).toBeNull()
  })

  it("does not resolve by display name — segments are ids only", () => {
    expect(resolveChannelRefBase(directory, "<#studio:general>")).toBeNull()
  })

  it("returns null on the retired `/server/channel` grammar", () => {
    expect(resolveChannelRefBase(directory, "/studio/general")).toBeNull()
    expect(resolveChannelRefBase(directory, "/srv_studio/chn_general")).toBeNull()
  })

  it("returns null on malformed input", () => {
    expect(resolveChannelRefBase(directory, "not-a-ref")).toBeNull()
    expect(resolveChannelRefBase(directory, "<#srv_studio>")).toBeNull()
    expect(resolveChannelRefBase(directory, "<#srv_studio:>")).toBeNull()
    expect(resolveChannelRefBase(directory, "<#:chn_general>")).toBeNull()
  })
})

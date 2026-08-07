import { describe, it, expect } from "vitest"
import { resolveChannelRefBase, resolveServerRefBase, type ChannelRefDirectory } from "./channel-ref"

const directory: ChannelRefDirectory = [
  {
    id: "srv_studio",
    name: "studio",
    discriminator: "0042",
    channels: [
      { id: "chn_general", name: "general" },
      { id: "chn_random", name: "random" },
    ],
  },
  {
    id: "srv_other",
    name: "other",
    discriminator: "12345",
    channels: [{ id: "chn_dup", name: "general" }],
  },
]

describe("resolveChannelRefBase", () => {
  it("resolves a channel id under a handled server", () => {
    const resolved = resolveChannelRefBase(directory, "/studio#0042/chn_general")
    expect(resolved?.server.id).toBe("srv_studio")
    expect(resolved?.channel.id).toBe("chn_general")
    expect(resolved?.threadRootSeq).toBeUndefined()
  })

  it("resolves by exact server handle and channel name", () => {
    const resolved = resolveChannelRefBase(directory, "/studio#0042/general")
    expect(resolved?.server.id).toBe("srv_studio")
    expect(resolved?.channel.id).toBe("chn_general")
  })

  it("resolves a handled server with index-aligned ASCII case folding", () => {
    expect(resolveChannelRefBase(directory, "/STUDIO#0042/general")?.server.id).toBe("srv_studio")
  })

  it("rejects a raw server id even when it matches a directory row", () => {
    const collidingDirectory: ChannelRefDirectory = [
      { id: "srv_studio", name: "studio", discriminator: "0042", channels: [{ id: "chn_general", name: "general" }] },
      { id: "srv_named_like_id", name: "srv_studio", discriminator: "0002", channels: [{ id: "chn_other", name: "other" }] },
    ]
    expect(resolveChannelRefBase(collidingDirectory, "/srv_studio/chn_general")).toBeNull()
  })

  it("two same-named servers require a discriminator instead of selecting the first", () => {
    const dupServers: ChannelRefDirectory = [
      { id: "srv_a", name: "dup", discriminator: "0042", channels: [{ id: "chn_a", name: "general" }] },
      { id: "srv_b", name: "dup", discriminator: "12345", channels: [{ id: "chn_b", name: "general" }] },
    ]
    expect(resolveChannelRefBase(dupServers, "/dup/general")).toBeNull()
    expect(resolveChannelRefBase(dupServers, "/DUP#0042/general")?.server.id).toBe("srv_a")
    expect(resolveChannelRefBase(dupServers, "/dup#12345/general")?.server.id).toBe("srv_b")
  })

  it("two same-named channels within one server resolve to the first one in array order", () => {
    const dupChannels: ChannelRefDirectory = [
      {
        id: "srv_studio",
        name: "studio",
        discriminator: "0042",
        channels: [
          { id: "chn_first", name: "dup" },
          { id: "chn_second", name: "dup" },
        ],
      },
    ]
    const resolved = resolveChannelRefBase(dupChannels, "/studio#0042/dup")
    expect(resolved?.channel.id).toBe("chn_first")
  })

  it("returns null when the server isn't in the directory", () => {
    expect(resolveChannelRefBase(directory, "/nope#0042/general")).toBeNull()
  })

  it("returns null when the channel isn't in the resolved server", () => {
    expect(resolveChannelRefBase(directory, "/studio#0042/nope")).toBeNull()
  })

  it("resolves the thread form /server/channel/#42 and surfaces threadRootSeq: 42", () => {
    const resolved = resolveChannelRefBase(directory, "/studio#0042/general/#42")
    expect(resolved?.channel.id).toBe("chn_general")
    expect(resolved?.threadRootSeq).toBe(42)
  })

  it("resolves the thread-reply form /server/channel/#5#42 and surfaces both threadRootSeq and seq", () => {
    const resolved = resolveChannelRefBase(directory, "/studio#0042/general/#5#42")
    expect(resolved?.channel.id).toBe("chn_general")
    expect(resolved?.threadRootSeq).toBe(5)
    expect(resolved?.seq).toBe(42)
  })

  it("returns null instead of throwing on malformed input (fails parseRef)", () => {
    expect(resolveChannelRefBase(directory, "not-a-ref")).toBeNull()
    expect(resolveChannelRefBase(directory, "/onlyserver")).toBeNull()
  })
})

describe("resolveServerRefBase", () => {
  it("rejects a raw server id", () => {
    expect(resolveServerRefBase(directory, "/srv_studio")).toBeNull()
  })

  it("rejects a bare server display name", () => {
    expect(resolveServerRefBase(directory, "/studio")).toBeNull()
  })

  it("does not treat an id-shaped segment as a server identity", () => {
    const collidingDirectory: ChannelRefDirectory = [
      { id: "srv_studio", name: "studio", discriminator: "0042", channels: [] },
      { id: "srv_named_like_id", name: "srv_studio", discriminator: "0002", channels: [] },
    ]
    expect(resolveServerRefBase(collidingDirectory, "/srv_studio")).toBeNull()
  })

  it("returns null when the server isn't in the directory", () => {
    expect(resolveServerRefBase(directory, "/nope#0042")).toBeNull()
  })

  it("resolves four-digit and expanded handles case-insensitively", () => {
    expect(resolveServerRefBase(directory, "/STUDIO#0042")?.id).toBe("srv_studio")
    expect(resolveServerRefBase(directory, "/other#12345")?.id).toBe("srv_other")
  })

  it("returns null for a multi-segment ref — that's channelRef's job, not serverRef's", () => {
    expect(resolveServerRefBase(directory, "/studio#0042/general")).toBeNull()
  })

  it("returns null for malformed input", () => {
    expect(resolveServerRefBase(directory, "not-a-ref")).toBeNull()
    expect(resolveServerRefBase(directory, "/")).toBeNull()
  })
})

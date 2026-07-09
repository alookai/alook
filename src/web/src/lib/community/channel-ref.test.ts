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
  it("resolves a bare /server/channel by id for both segments", () => {
    const resolved = resolveChannelRefBase(directory, "/srv_studio/chn_general")
    expect(resolved?.server.id).toBe("srv_studio")
    expect(resolved?.channel.id).toBe("chn_general")
    expect(resolved?.threadRootSeq).toBeUndefined()
  })

  it("resolves by exact display name for both segments", () => {
    const resolved = resolveChannelRefBase(directory, "/studio/general")
    expect(resolved?.server.id).toBe("srv_studio")
    expect(resolved?.channel.id).toBe("chn_general")
  })

  it("id match takes precedence over a colliding name match", () => {
    // A server literally named "srv_studio" would collide with the id lookup
    // for the first directory entry — id-first precedence must win.
    const collidingDirectory: ChannelRefDirectory = [
      { id: "srv_studio", name: "studio", channels: [{ id: "chn_general", name: "general" }] },
      { id: "srv_named_like_id", name: "srv_studio", channels: [{ id: "chn_other", name: "other" }] },
    ]
    const resolved = resolveChannelRefBase(collidingDirectory, "/srv_studio/chn_general")
    expect(resolved?.server.id).toBe("srv_studio")
  })

  it("two same-named servers resolve to the first one in directory order", () => {
    const dupServers: ChannelRefDirectory = [
      { id: "srv_a", name: "dup", channels: [{ id: "chn_a", name: "general" }] },
      { id: "srv_b", name: "dup", channels: [{ id: "chn_b", name: "general" }] },
    ]
    const resolved = resolveChannelRefBase(dupServers, "/dup/general")
    expect(resolved?.server.id).toBe("srv_a")
  })

  it("two same-named channels within one server resolve to the first one in array order", () => {
    const dupChannels: ChannelRefDirectory = [
      {
        id: "srv_studio",
        name: "studio",
        channels: [
          { id: "chn_first", name: "dup" },
          { id: "chn_second", name: "dup" },
        ],
      },
    ]
    const resolved = resolveChannelRefBase(dupChannels, "/studio/dup")
    expect(resolved?.channel.id).toBe("chn_first")
  })

  it("returns null when the server isn't in the directory", () => {
    expect(resolveChannelRefBase(directory, "/nope/general")).toBeNull()
  })

  it("returns null when the channel isn't in the resolved server", () => {
    expect(resolveChannelRefBase(directory, "/studio/nope")).toBeNull()
  })

  it("resolves the thread form /server/channel/#42 and surfaces threadRootSeq: 42", () => {
    const resolved = resolveChannelRefBase(directory, "/studio/general/#42")
    expect(resolved?.channel.id).toBe("chn_general")
    expect(resolved?.threadRootSeq).toBe(42)
  })

  it("returns null instead of throwing on malformed input (fails parseRef)", () => {
    expect(resolveChannelRefBase(directory, "not-a-ref")).toBeNull()
    expect(resolveChannelRefBase(directory, "/onlyserver")).toBeNull()
  })
})

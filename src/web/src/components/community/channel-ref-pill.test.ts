import { describe, it, expect } from "vitest"
import { describeChannelRefPillView } from "./channel-ref-pill"
import type { ResolvedChannelRef } from "@/lib/community/channel-ref"

const server = { id: "srv_1", name: "Studio" }
const channel = { id: "chn_1", name: "general" }

function resolved(overrides: Partial<ResolvedChannelRef> = {}): ResolvedChannelRef {
  return { server, channel, ...overrides }
}

describe("describeChannelRefPillView", () => {
  it("resolved: null, directoryLoading: true → muted", () => {
    const view = describeChannelRefPillView({
      ref: "<#srv_1:chn_1>",
      resolved: null,
      directoryLoading: true,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "<#srv_1:chn_1>" })
  })

  it("resolved: null, directoryLoading: false → plain with text equal to the original ref", () => {
    const view = describeChannelRefPillView({
      ref: "<#srv_gone:chn_gone>",
      resolved: null,
      directoryLoading: false,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "plain", text: "<#srv_gone:chn_gone>" })
  })

  it("resolved present → pill, no serverPrefix when resolved.server.id === currentServerId", () => {
    const view = describeChannelRefPillView({
      ref: "<#srv_1:chn_1>",
      resolved: resolved(),
      directoryLoading: false,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "chn_1" },
    })
  })

  it("resolved.server.id !== currentServerId → pill with serverPrefix set to the server's name", () => {
    const view = describeChannelRefPillView({
      ref: "<#srv_1:chn_1>",
      resolved: resolved(),
      directoryLoading: false,
      currentServerId: "srv_other",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: "Studio",
      href: { serverId: "srv_1", channelId: "chn_1" },
    })
  })
})

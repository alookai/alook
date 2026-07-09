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
      ref: "/srv_1/chn_1",
      resolved: null,
      directoryLoading: true,
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "/srv_1/chn_1" })
  })

  it("resolved: null, directoryLoading: false → plain with text equal to the original ref", () => {
    const view = describeChannelRefPillView({
      ref: "/usr/bin/ls",
      resolved: null,
      directoryLoading: false,
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "plain", text: "/usr/bin/ls" })
  })

  it("resolved present, no threadRootSeq → pill, no serverPrefix when resolved.server.id === currentServerId", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1",
      resolved: resolved(),
      directoryLoading: false,
      thread: null,
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
      ref: "/srv_1/chn_1",
      resolved: resolved(),
      directoryLoading: false,
      thread: null,
      currentServerId: "srv_other",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: "Studio",
      href: { serverId: "srv_1", channelId: "chn_1" },
    })
  })

  it("threadRootSeq set, thread: undefined (loading) → muted", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
      directoryLoading: false,
      thread: undefined,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "general" })
  })

  it("threadRootSeq set, thread found → pill targeting the thread id, label = thread name", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
      directoryLoading: false,
      thread: { id: "thr_1", name: "Thread about X", parentSeq: 42 },
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "Thread about X",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "thr_1" },
    })
  })

  it("threadRootSeq set, thread: null (loaded, no match) → pill targeting the base channel — no invented thread link, but carries threadSuffix for the caller to render as trailing plain text", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
      directoryLoading: false,
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "chn_1" },
      threadSuffix: 42,
    })
  })

  it("cross-server thread-degrade case still sets serverPrefix and threadSuffix", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
      directoryLoading: false,
      thread: null,
      currentServerId: "srv_other",
    })
    expect(view.kind).toBe("pill")
    expect((view as { serverPrefix?: string; threadSuffix?: number }).serverPrefix).toBe("Studio")
    expect((view as { serverPrefix?: string; threadSuffix?: number }).threadSuffix).toBe(42)
  })

  it("resolved thread found → pill does NOT carry threadSuffix (suffix is only for the degrade case)", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
      directoryLoading: false,
      thread: { id: "thr_1", name: "Thread about X", parentSeq: 42 },
      currentServerId: "srv_1",
    })
    expect((view as { threadSuffix?: number }).threadSuffix).toBeUndefined()
  })
})

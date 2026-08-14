import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import { describeChannelRefPillView } from "./channel-ref-pill"
import { ChannelPill } from "./inline-marks"
import type { ResolvedChannelRef } from "@/lib/community/channel-ref"

const server = { id: "srv_1", name: "Studio" }
const channel = { id: "chn_1", name: "general" }

function resolved(overrides: Partial<ResolvedChannelRef> = {}): ResolvedChannelRef {
  return { server, channel, ...overrides }
}

describe("describeChannelRefPillView", () => {
  it("resolved: null → muted", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1",
      resolved: null,
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "/srv_1/chn_1", showIcon: false })
  })

  it("resolved: null keeps the original ref as its muted label", () => {
    const view = describeChannelRefPillView({
      ref: "/studio#0042/general#42",
      resolved: null,
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "/studio#0042/general#42", showIcon: false })
  })

  it("resolved present, no threadRootSeq → pill, no serverPrefix when resolved.server.id === currentServerId", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1",
      resolved: resolved(),
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

  it("channel-message ref (resolved.seq set, no thread) → pill carrying messageSuffix as a trailing #N cursor", () => {
    // `/server/channel#N` (message-ref-upgrade.md): the pill targets the channel
    // and renders `#N` as a plain trailing cursor — same treatment as a thread
    // message ref's `#M`. Cross-channel auto-scroll to the seq isn't wired (the
    // app deep-links by id, not seq), so `#N` is a cursor, not a link anchor.
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1#42",
      resolved: resolved({ seq: 42 }),
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "chn_1" },
      messageSuffix: 42,
    })
  })

  it("resolved.server.id !== currentServerId → pill with serverPrefix set to the server's name", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1",
      resolved: resolved(),
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
      thread: undefined,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({ kind: "muted", label: "general" })
  })

  it("threadRootSeq set, thread found → pill targeting the thread id, label = thread name", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#42",
      resolved: resolved({ threadRootSeq: 42 }),
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
      thread: { id: "thr_1", name: "Thread about X", parentSeq: 42 },
      currentServerId: "srv_1",
    })
    expect((view as { threadSuffix?: number }).threadSuffix).toBeUndefined()
  })

  it("thread-reply form (threadRootSeq + seq), thread resolved → pill targets thread id, carries messageSuffix but no threadSuffix", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#5#42",
      resolved: resolved({ threadRootSeq: 5, seq: 42 }),
      thread: { id: "thr_1", name: "Thread about X", parentSeq: 5 },
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "Thread about X",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "thr_1" },
      messageSuffix: 42,
    })
  })

  it("thread-reply form, thread-not-found degrade → pill targets base channel, carries BOTH threadSuffix and messageSuffix", () => {
    const view = describeChannelRefPillView({
      ref: "/srv_1/chn_1/#5#42",
      resolved: resolved({ threadRootSeq: 5, seq: 42 }),
      thread: null,
      currentServerId: "srv_1",
    })
    expect(view).toEqual({
      kind: "pill",
      label: "general",
      serverPrefix: undefined,
      href: { serverId: "srv_1", channelId: "chn_1" },
      threadSuffix: 5,
      messageSuffix: 42,
    })
  })
})

describe("ChannelPill icon", () => {
  it("shows the channel icon by default", () => {
    const html = renderToStaticMarkup(createElement(ChannelPill, { muted: true }, "general"))
    expect(html).toContain("<svg")
  })

  it("omits the channel icon when showIcon is false", () => {
    const html = renderToStaticMarkup(createElement(ChannelPill, { muted: true, showIcon: false }, "/missing#0042/general"))
    expect(html).not.toContain("<svg")
    expect(html).toContain("/missing#0042/general")
  })
})

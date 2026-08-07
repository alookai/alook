import { describe, it, expect, vi, beforeEach } from "vitest"

const mockResolveTargetForMember = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()
const mockRequireMessageBearingSurface = vi.fn()

vi.mock("./resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))
vi.mock("./permissions", () => ({
  requireMessageSurfaceAccess: (...a: unknown[]) => mockRequireMessageSurfaceAccess(...a),
}))
vi.mock("./channel-write-guard", () => ({
  requireMessageBearingSurface: (...a: unknown[]) => mockRequireMessageBearingSurface(...a),
}))

import { parseTargetDescriptor, resolveMessageTarget } from "./message-door"

const db = {} as never

describe("parseTargetDescriptor — id-xor-ref (Aigneis #190)", () => {
  it("accepts { id } alone", () => {
    expect(parseTargetDescriptor({ id: "c1" })).toEqual({ ok: true, value: { id: "c1" } })
  })

  it("accepts { ref } alone, threading create-if-missing (ref arm only)", () => {
    expect(parseTargetDescriptor({ ref: "/s/c", createDmIfMissing: true })).toEqual({
      ok: true,
      value: { ref: "/s/c", createDmIfMissing: true, createThreadIfMissing: undefined },
    })
  })

  it("rejects neither field", () => {
    expect(parseTargetDescriptor({})).toMatchObject({ ok: false, status: 400 })
  })

  it("rejects both fields (must be exactly one)", () => {
    expect(parseTargetDescriptor({ id: "c1", ref: "/s/c" })).toMatchObject({ ok: false, status: 400 })
  })

  it("rejects create-if-missing on the { id } arm (resolve≠create, structural)", () => {
    expect(parseTargetDescriptor({ id: "c1", createDmIfMissing: true })).toMatchObject({
      ok: false,
      status: 400,
    })
    expect(parseTargetDescriptor({ id: "c1", createThreadIfMissing: true })).toMatchObject({
      ok: false,
      status: 400,
    })
  })
})

describe("resolveMessageTarget — single mask output + surface→target (Aigneis ④)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireMessageBearingSurface.mockReturnValue({ ok: true })
  })

  it("id arm: passes the raw id THROUGH requireMessageSurfaceAccess (never trusts a web-sent id)", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", type: "text", serverId: "s1", parentChannelId: null } },
    })
    const res = await resolveMessageTarget(db, "u1", { id: "c1" }, "human")
    // The id did NOT skip the mask — the gate was invoked with it.
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith(db, "c1", "u1")
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, value: { target: { kind: "channel", channelId: "c1", serverId: "s1" }, isDm: false } })
  })

  it("ref arm: resolves then passes the resolved id through the SAME mask", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", type: "text", serverId: "s1", parentChannelId: null } },
    })
    const res = await resolveMessageTarget(db, "u1", { ref: "/s/c" }, "bot")
    expect(mockResolveTargetForMember).toHaveBeenCalledWith(db, "u1", "/s/c", {
      createDmIfMissing: undefined,
      createThreadIfMissing: undefined,
      callerKind: "bot",
    })
    // Resolved id went through the same single mask output.
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith(db, "c1", "u1")
    expect(res.ok).toBe(true)
  })

  it("mask failure propagates verbatim (opaque 404 / 403 from the gate)", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: false, status: 404, error: "not found" })
    const res = await resolveMessageTarget(db, "u1", { id: "c1" }, "human")
    expect(res).toEqual({ ok: false, status: 404, error: "not found" })
  })

  it("dm surface → dm-kind target, otherUserId consumed from the dispatch peer (no re-query)", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "dm", dm: { id: "d1", otherUserId: "u2" } },
    })
    const res = await resolveMessageTarget(db, "u1", { id: "d1" }, "human")
    expect(res).toEqual({ ok: true, value: { target: { kind: "dm", channelId: "d1", otherUserId: "u2" }, isDm: true } })
    // No bearing guard on the DM arm (a DM is a valid target).
    expect(mockRequireMessageBearingSurface).not.toHaveBeenCalled()
  })

  it("channel + parentChannelId + type thread → thread-kind target", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "t1", type: "thread", serverId: "s1", parentChannelId: "p1" } },
    })
    const res = await resolveMessageTarget(db, "u1", { id: "t1" }, "human")
    expect(res).toMatchObject({ ok: true, value: { target: { kind: "thread", channelId: "t1", parentChannelId: "p1", serverId: "s1" } } })
  })

  it("bearing guard failure (e.g. forum top-level) → error, no target", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "f1", type: "forum", serverId: "s1", parentChannelId: null } },
    })
    mockRequireMessageBearingSurface.mockReturnValue({ ok: false, status: 400, error: "not message-bearing" })
    const res = await resolveMessageTarget(db, "u1", { id: "f1" }, "human")
    expect(res).toMatchObject({ ok: false, status: 400 })
  })

  it("ref-resolve error (incl ambiguous-server hint) is threaded through, mask NOT reached", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 400, message: "ambiguous server name", hint: [{ id: "s1" }] })
    const res = await resolveMessageTarget(db, "u1", { ref: "/gaming/c" }, "bot")
    expect(res).toMatchObject({ ok: false, status: 400, error: "ambiguous server name", hint: [{ id: "s1" }] })
    expect(mockRequireMessageSurfaceAccess).not.toHaveBeenCalled()
  })

  it("create-if-missing flags flow ONLY on the ref arm into resolveTargetForMember", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "dm", channelId: "d1", otherUserId: "u2" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "dm", dm: { id: "d1", otherUserId: "u2" } },
    })
    await resolveMessageTarget(db, "u1", { ref: "/.dm/bob#0001", createDmIfMissing: true }, "bot")
    expect(mockResolveTargetForMember).toHaveBeenCalledWith(db, "u1", "/.dm/bob#0001", {
      createDmIfMissing: true,
      createThreadIfMissing: undefined,
      callerKind: "bot",
    })
  })
})

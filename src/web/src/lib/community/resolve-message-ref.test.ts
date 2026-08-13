import { beforeEach, describe, expect, it, vi } from "vitest"

const mockResolveTargetForMember = vi.fn()
const mockGetMessageIdentityByChannelAndSeq = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...args: unknown[]) => mockResolveTargetForMember(...args),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessage: {
        getMessageIdentityByChannelAndSeq: (...args: unknown[]) => mockGetMessageIdentityByChannelAndSeq(...args),
      },
    },
  }
})

import { resolveMessageRefForBot } from "./resolve-message-ref"

describe("resolveMessageRefForBot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: true, value: { surface: "channel" } })
    mockGetMessageIdentityByChannelAndSeq.mockResolvedValue({ id: "m42", channelId: "c1" })
  })

  it.each([
    "/demo#0001/general",
    "/demo#0001/general/#7",
    "/.dm/peer#0002",
  ])("resolves channel/thread/DM scope first, then seq", async (channel) => {
    const result = await resolveMessageRefForBot({}, "bot_1", { channel, seq: 42 }, {
      requireSurfaceAccess: true,
    })
    expect(result).toEqual({ ok: true, messageId: "m42", channelId: "c1" })
    expect(mockResolveTargetForMember).toHaveBeenCalledWith({}, "bot_1", channel, {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith({}, "c1", "bot_1")
    expect(mockGetMessageIdentityByChannelAndSeq).toHaveBeenCalledWith({}, { channelId: "c1" }, 42)
  })

  it.each([
    [{ channel: "/demo#0001/general" }, "valid seq required"],
    [{ channel: "/demo#0001/general", seq: 0 }, "valid seq required"],
    [{ seq: 42 }, "channel ref required"],
  ])("rejects malformed message addressing locally", async (body, error) => {
    await expect(resolveMessageRefForBot({}, "bot_1", body, {
      requireSurfaceAccess: true,
    })).resolves.toMatchObject({ ok: false, status: 400, error })
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })

  it("preserves scope-first opaque resolution failures", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "channel not found" })
    const result = await resolveMessageRefForBot({}, "bot_1", {
      channel: "/hidden#0001/private", seq: 42,
    }, { requireSurfaceAccess: true })
    expect(result).toEqual({ ok: false, status: 404, error: "channel not found" })
    expect(mockGetMessageIdentityByChannelAndSeq).not.toHaveBeenCalled()
  })

  it("blocks set before message lookup when the DM surface is blocked", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "dm", channelId: "dm1", otherUserId: "peer" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: false, status: 403, error: "blocked" })
    const result = await resolveMessageRefForBot({}, "bot_1", {
      channel: "/.dm/peer#0002", seq: 42,
    }, { requireSurfaceAccess: true })
    expect(result).toEqual({ ok: false, status: 403, error: "blocked" })
    expect(mockGetMessageIdentityByChannelAndSeq).not.toHaveBeenCalled()
  })

  it("allows remove's surface-gate-free cleanup path to skip the block gate", async () => {
    const result = await resolveMessageRefForBot({}, "bot_1", {
      channel: "/.dm/peer#0002", seq: 42,
    }, { requireSurfaceAccess: false })
    expect(result).toEqual({ ok: true, messageId: "m42", channelId: "c1" })
    expect(mockRequireMessageSurfaceAccess).not.toHaveBeenCalled()
  })

  it("404s when the scope exists but the seq does not", async () => {
    mockGetMessageIdentityByChannelAndSeq.mockResolvedValue(null)
    const result = await resolveMessageRefForBot({}, "bot_1", {
      channel: "/demo#0001/general", seq: 999,
    }, { requireSurfaceAccess: true })
    expect(result).toEqual({ ok: false, status: 404, error: "message not found" })
  })
})

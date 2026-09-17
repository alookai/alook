import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  reply: vi.fn(),
  joined: vi.fn(),
}))

vi.mock("@/lib/analytics", () => ({
  trackCommunityRuntimeConnected: mocks.runtime,
  trackFirstAgentReplyPersisted: mocks.reply,
  trackInvitedHumanJoined: mocks.joined,
}))

import {
  _resetCommunityFunnelAnalyticsForTesting,
  decodeCommunityFunnelEvents,
  drainCommunityFunnelEvents,
} from "./funnel-analytics"

function response(payload: unknown, ok = true) {
  return { ok, json: vi.fn().mockResolvedValue(payload) } as unknown as Response
}

describe("Community funnel analytics drain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCommunityFunnelAnalyticsForTesting()
  })

  it("accepts only exact low-cardinality event shapes", () => {
    expect(decodeCommunityFunnelEvents({ events: [
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "dm" },
      { event: "invited_human_joined", surface: "community" },
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon", machineId: "secret" },
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "group" },
      { event: "unknown", surface: "community" },
    ] })).toEqual([
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "dm" },
      { event: "invited_human_joined", surface: "community" },
    ])
  })

  it("publishes exact events and coalesces a trigger arriving in flight", async () => {
    let resolveFirst!: (value: Response) => void
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(response({ events: [
        { event: "invited_human_joined", surface: "community" },
      ] }))
    vi.stubGlobal("fetch", fetchMock)

    const initial = drainCommunityFunnelEvents()
    const coalesced = drainCommunityFunnelEvents()
    expect(coalesced).toBe(initial)
    resolveFirst(response({ events: [
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "thread" },
    ] }))
    await initial

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/community/analytics/funnel-events", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    })
    expect(mocks.runtime).toHaveBeenCalledOnce()
    expect(mocks.reply).toHaveBeenCalledWith("thread")
    expect(mocks.joined).toHaveBeenCalledOnce()
  })

  it("fails open on fetch errors and non-success responses", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ events: [] }, false))
    vi.stubGlobal("fetch", fetchMock)

    await expect(drainCommunityFunnelEvents()).resolves.toBeUndefined()
    await expect(drainCommunityFunnelEvents()).resolves.toBeUndefined()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
})

import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  reply: vi.fn(),
  joined: vi.fn(),
  product: vi.fn(),
  native: false,
  consent: null as string | null,
}))

vi.mock("@/lib/analytics", () => ({
  trackCommunityRuntimeConnected: mocks.runtime,
  trackFirstAgentReplyPersisted: mocks.reply,
  trackInvitedHumanJoined: mocks.joined,
}))

vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(), isTauri: () => mocks.native }))
vi.mock("@/lib/analytics-consent", () => ({ readAnalyticsConsent: () => mocks.consent }))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: mocks.product }))
import { createStore } from "@tanstack/store"

import {
  drainInvitedHumanJoined,
  _resetCommunityFunnelAnalyticsForTesting,
  decodeCommunityFunnelEvents,
  drainCommunityFunnelEvents,
} from "./funnel-analytics"

function response(payload: unknown, ok = true) {
  return Response.json(payload, { status: ok ? 200 : 500, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
}

describe("Community funnel analytics drain", () => {
  let lifecycle = createStore({ active: true, generation: 1 })
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCommunityFunnelAnalyticsForTesting()
    lifecycle = createStore({ active: true, generation: 1 })
    mocks.native = false
    mocks.consent = null
    vi.stubGlobal("window", { location: new URL("https://alook.ai/c/me") })
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

    const initial = drainCommunityFunnelEvents(lifecycle)
    const coalesced = drainCommunityFunnelEvents(lifecycle)
    expect(coalesced).toBe(initial)
    resolveFirst(response({ events: [
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
      { event: "first_agent_reply_persisted", surface: "community", conversation_type: "thread" },
    ] }))
    await initial

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/community/analytics/funnel-events", {
      method: "POST",
      headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    })
    expect(mocks.runtime).toHaveBeenCalledOnce()
    expect(mocks.reply).toHaveBeenCalledWith("thread", expect.any(Function))
    expect(mocks.joined).not.toHaveBeenCalled()
    expect(mocks.product).not.toHaveBeenCalled()
  })

  it("fails open on fetch errors and non-success responses", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ events: [] }, false))
    vi.stubGlobal("fetch", fetchMock)

    await expect(drainCommunityFunnelEvents(lifecycle)).resolves.toBeUndefined()
    await expect(drainCommunityFunnelEvents(lifecycle)).resolves.toBeUndefined()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
})

describe.each([
  ["invited_human_joined", drainInvitedHumanJoined],
  ["legacy", drainCommunityFunnelEvents],
] as const)("%s Web drain ownership", (scope, drainEvents) => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCommunityFunnelAnalyticsForTesting()
    mocks.native = false
    mocks.consent = null
    vi.stubGlobal("window", { location: new URL("https://alook.ai/c/me") })
  })
  afterEach(() => vi.unstubAllGlobals())
  const joined = scope === "legacy"
    ? { event: "runtime_connected", surface: "community", connection_type: "local_daemon" }
    : { event: "invited_human_joined", surface: "community" }

  it.each([null, "granted"])("claims only its scope and publishes through the finite sender with %s consent", async (consent) => {
    mocks.consent = consent
    const lifecycle = createStore({ active: true, generation: 1 })
    const fetchMock = vi.fn().mockResolvedValue(response({ events: [joined, scope === "legacy" ? { event: "invited_human_joined", surface: "community" } : { event: "runtime_connected", surface: "community", connection_type: "local_daemon" }] }))
    vi.stubGlobal("fetch", fetchMock)
    await drainEvents(lifecycle)
    expect(fetchMock).toHaveBeenCalledWith((scope === "legacy" ? "/api/community/analytics/funnel-events" : "/api/community/analytics/funnel-events?event=invited_human_joined"), expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }))
    if (scope === "legacy") {
      expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith(expect.any(Function))
      expect(mocks.product).not.toHaveBeenCalled()
    } else {
      expect(mocks.product).toHaveBeenCalledExactlyOnceWith({ event: "invited_human_joined" }, expect.any(Function))
      expect(mocks.runtime).not.toHaveBeenCalled()
    }
  })

  it("does not claim under denied, Native or retired ownership", async () => {
    const lifecycle = createStore({ active: true, generation: 1 })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    mocks.consent = "denied"
    await drainEvents(lifecycle)
    mocks.consent = null; mocks.native = true
    await drainEvents(lifecycle)
    mocks.native = false
    vi.stubGlobal("window", { location: new URL("http://localhost:3000/c/me") })
    await drainEvents(lifecycle)
    vi.stubGlobal("window", { location: new URL("https://alook.ai/c/me") })
    lifecycle.setState(state => ({ ...state, active: false }))
    await drainEvents(lifecycle)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(["owner", "consent"])("rejects a late receipt and aborts retired requests after %s changes", async (change) => {
    const lifecycle = createStore({ active: true, generation: 1 })
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const fetchMock = vi.fn().mockReturnValue(pending)
    vi.stubGlobal("fetch", fetchMock)
    const drain = drainEvents(lifecycle)
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    if (change === "owner") lifecycle.setState(state => ({ ...state, active: false, generation: state.generation + 1 }))
    else mocks.consent = "denied"
    if (change === "owner") expect(signal.aborted).toBe(true)
    finish(response({ events: [joined] }))
    await drain
    expect(mocks.product).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })

  it("coalesces within one owner and lets an independent replacement claim immediately", async () => {
    const lifecycle = createStore({ active: true, generation: 1 })
    const replacement = createStore({ active: true, generation: 1 })
    let finish!: (response: Response) => void
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValue(response({ events: [] }))
    vi.stubGlobal("fetch", fetchMock)
    const original = drainEvents(lifecycle)
    expect(drainEvents(lifecycle)).toBe(original)
    await drainEvents(replacement)
    finish(response({ events: [joined] }))
    await original
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const guard = (scope === "legacy" ? mocks.runtime.mock.calls[0][0] : mocks.product.mock.calls[0][1]) as () => void
    lifecycle.setState(state => ({ ...state, active: false }))
    expect(guard).toThrow("Retired community analytics owner")
  })

  it("leaves business execution unaffected by network and rejected responses", async () => {
    const lifecycle = createStore({ active: true, generation: 1 })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response({}, false)))
    await expect(drainEvents(lifecycle)).resolves.toBeUndefined()
    await expect(drainEvents(lifecycle)).resolves.toBeUndefined()
    expect(mocks.product).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
})

it("does not claim a browser event without a browser", async () => {
  const lifecycle = createStore({ active: true, generation: 1 })
  const fetchMock = vi.fn()
  vi.stubGlobal("window", undefined)
  vi.stubGlobal("fetch", fetchMock)
  try {
    await drainInvitedHumanJoined(lifecycle)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})


describe("current funnel response qualification", () => {
  afterEach(() => vi.unstubAllGlobals())
  it.each([null, BUSINESS_SCHEMA_VERSION - 1, BUSINESS_SCHEMA_VERSION + 1])("drops unconfirmed optional receipts (%s) without global upgrade", async version => {
    vi.clearAllMocks(); _resetCommunityFunnelAnalyticsForTesting()
    mocks.native = false; mocks.consent = null; vi.stubGlobal("window", { location: new URL("https://alook.ai/c/me") })
    const create = () => Response.json({ events: [{ event: "invited_human_joined", surface: "community" }, { event: "runtime_connected", surface: "community", connection_type: "local_daemon" }] }, { headers: version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: String(version) } })
    const fetchMock = vi.fn(async () => create()); vi.stubGlobal("fetch", fetchMock)
    const { businessSchemaLifecycle } = await import("@/lib/business-schema-lifecycle")
    businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
    await drainCommunityFunnelEvents(createStore({ active: true, generation: 1 }))
    await drainInvitedHumanJoined(createStore({ active: true, generation: 1 }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, options] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) expect(new Headers(options.headers).get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(mocks.product).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled()
    expect(businessSchemaLifecycle.get().phase).toBe("current")
  })
})

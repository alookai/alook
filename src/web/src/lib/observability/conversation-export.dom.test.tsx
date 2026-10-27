import { afterEach, expect, it, vi } from "vitest"
import type { Faro } from "@grafana/faro-web-sdk"
import { QueryClientProvider } from "@tanstack/react-query"
import { useLayoutEffect } from "react"
import { act, render } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { communityKeys } from "@/lib/query-keys"
import { useMessages } from "@/hooks/community/use-messages"
import { announceAnalyticsConsent } from "@/lib/analytics-consent"
import { COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { traceResponse } from "./trace-response"
import { useObservedRegion } from "./regions"
import { installMessageScrollFixture, restoreMessageScrollFixture, mount } from "@/test/message-scroll-fixture"

const native = vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  return { faro: undefined as Faro | undefined }
})
vi.mock("@grafana/faro-web-sdk", async original => {
  const real = await original<typeof import("@grafana/faro-web-sdk")>()
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => {
    native.faro = real.initializeFaro(...args)
    return native.faro
  } }
})

afterEach(async () => {
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/"
    announceAnalyticsConsent("denied")
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  })
  restoreMessageScrollFixture()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

it("exports real cache, entry, repair and request roles through installed Faro and beforeSend with finite private-safe fields", async () => {
  installMessageScrollFixture()
  sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  window.history.replaceState(null, "", "/c/channels/s1/c1")
  const owner = await createCommunityQueryOwner()
  const value = conversationEntryFixture()
  value.messages[0].content = "PRIVATE257-message-body"
  await seedConversationEntry(owner.client, value)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  const sent: unknown[] = []
  let releaseEntry!: () => void
  let releaseRepair!: () => void
  const next = { ...value, page: { ...value.page, latestSeq: 2, hasMoreNewer: true, newerCursor: "next" } }
  const second = { ...value.messages[0], id: "m2", seq: 2, createdAt: "2026-10-01T00:00:02.000Z" }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = input instanceof Request ? input.url : String(input)
    if (path === "https://collector.example/collect/public") {
      if (options?.body) sent.push(JSON.parse(String(options.body)))
      return new Response(null, { status: 204 })
    }
    const url = new URL(path, window.location.origin)
    const request = new Request(url, options)
    const respond = (body: unknown, version: number) => traceResponse(new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", [COMMUNITY_CONTRACT_HEADER]: String(version) },
    }), request, { isTraced: true, spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }) })
    if (url.searchParams.has("entry")) return new Promise<Response>(resolve => { releaseEntry = () => resolve(respond(next, 3)) })
    const page = { contractVersion: 2, channelId: "c1", surfaceReceipt: value.surfaceReceipt,
      messages: [second], page: { ...value.page, latestSeq: 2, hasMoreNewer: false } }
    if (url.searchParams.has("since")) return new Promise<Response>(resolve => { releaseRepair = () => resolve(respond(page, 2)) })
    if (url.searchParams.has("cursor")) return respond({ ...page, messages: [{ ...value.messages[0], id: "m0", seq: 0 }], page: { ...page.page, hasMoreOlder: false, olderCursor: null } }, 2)
    return respond({ ...page, messages: [...value.messages, second] }, 2)
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  announceAnalyticsConsent("granted")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  await act(async () => { bootstrapObservability("web"); setTelemetryUser("viewer") })
  await vi.waitFor(() => expect(native.faro).toBeDefined())
  const { beginNavigation } = await import("./context")
  const navigation = beginNavigation("/c/channels/s1/c1")!
  let latest!: ReturnType<typeof useMessages>
  function Probe({ ready, reason }: { ready: boolean; reason: "entry" | "position" | "none" }) {
    const feed = useMessages("c1", { serverId: "s1" })
    useLayoutEffect(() => { latest = feed }, [feed])
    useObservedRegion("messages", ready, 1, { wait_reason: reason, target_coverage: reason === "entry" ? "uncovered" : "covered" })
    return <p>{feed.messages.map(message => message.content).join(" ")}</p>
  }
  const node = (ready: boolean, reason: "entry" | "position" | "none") => <QueryClientProvider client={owner.client}>
    <CommunityDbProvider registry={owner.registry}><Probe ready={ready} reason={reason} /></CommunityDbProvider>
  </QueryClientProvider>
  const view = render(node(false, "entry"))
  try {
    await vi.waitFor(() => expect(releaseEntry).toBeTypeOf("function"))
    expect(latest.messages[0]?.content).toBe("PRIVATE257-message-body")
    expect(latest.isLoading).toBe(false)
    await act(async () => { view.rerender(node(false, "position")); releaseEntry() })
    await vi.waitFor(() => expect(releaseRepair).toBeTypeOf("function"))
    expect(latest.messages.map(message => message.id)).toEqual(["m1"])
    expect(latest.readSnapshotFetching).toBe(true)
    expect(latest.positionDataState).toBe("pending")
    expect(latest.targetPositionDataState).toBe("ready")
    expect(owner.client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") })[0]?.state.status).toBe("success")
    await act(async () => { releaseRepair(); await vi.advanceTimersByTimeAsync(1) })
    await vi.waitFor(() => expect(latest.messages.map(message => message.id)).toContain("m2"))
    let present!: ReturnType<typeof latest.jumpToPresent>
    await act(async () => { present = latest.jumpToPresent() })
    expect(present.accepted).toBe(true)
    const presentRequest = present
    if (presentRequest.accepted) await act(async () => { await presentRequest.completed })
    let older!: ReturnType<typeof latest.fetchOlder>
    await act(async () => { older = latest.fetchOlder() })
    expect(older.accepted).toBe(true)
    const olderRequest = older
    if (olderRequest.accepted) await act(async () => { await olderRequest.completed })
    await act(async () => view.rerender(node(true, "none")))
    native.faro!.api.pushEvent("conversation.cache", { cache_reason: "PRIVATE257-invalid", content: "PRIVATE257-content", cache_window: "ready" })
    const position = mount({ scrollToMessageId: "m4", positionDataState: "ready" })
    position.view.unmount()
    await act(async () => owner.registry.collections.channelMemberships.utils.writeDelete("c1:viewer:access"))
    await vi.advanceTimersByTimeAsync(5000)
    const events: Array<{ name: string; attributes: Record<string, string> }> = []
    const spans: Array<{ name: string; spanId: string; parentSpanId?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }> = []
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const row = value as Record<string, unknown>
      if (typeof row.name === "string" && row.attributes && !Array.isArray(row.attributes)) events.push(row as typeof events[number])
      if (typeof row.spanId === "string") spans.push(row as typeof spans[number])
      for (const child of Object.values(row)) visit(child)
    }
    visit(sent)
    expect(events).toContainEqual(expect.objectContaining({ name: "conversation.cache", attributes: expect.objectContaining({ cache_reason: "qualified", entry_status: "missing", cache_window: "ready" }) }))
    expect(events).toContainEqual(expect.objectContaining({ name: "conversation.cache", attributes: expect.objectContaining({ cache_reason: "access_missing", eligibility: "rejected" }) }))
    expect(events.filter(event => event.name === "conversation.entry").map(event => event.attributes.entry_stage)).toEqual(["start", "validated", "published", "delivered"])
    expect(events.filter(event => event.name === "conversation.reconcile").map(event => event.attributes.reconcile_stage)).toEqual(["start", "settled"])
    const roles = new Set(events.filter(event => event.name === "request.start").map(event => event.attributes.request_role))
    expect(roles).toEqual(new Set(["entry", "reconcile", "window", "pagination"]))
    expect(events).toContainEqual(expect.objectContaining({ name: "region.wait_change", attributes: expect.objectContaining({ wait_reason: "position", last_wait_reason: "entry" }) }))
    expect(events).toContainEqual(expect.objectContaining({ name: "position.finish", attributes: expect.objectContaining({ position_owner: "target", position_reason: "settled" }) }))
    const wait = spans.find(span => span.name === "region.wait")!
    expect(wait.parentSpanId).toBe(navigation.span!.spanContext().spanId)
    expect(Object.fromEntries(wait.attributes.map(attribute => [attribute.key, attribute.value.stringValue]))).toMatchObject({ initial_wait_reason: "entry", last_wait_reason: "position", wait_reason: "none", outcome: "success" })
    expect(spans.some(span => span.attributes.some(attribute => attribute.key === "request_role" && attribute.value.stringValue === "reconcile"))).toBe(true)
    const headers = events.filter(event => event.name === "request.headers")
    expect(headers.length).toBeGreaterThanOrEqual(4)
    expect(headers.every(event => event.attributes.server_sampling === "unavailable")).toBe(true)
    expect(headers.some(event => event.attributes.server_identity === "available")).toBe(true)
    expect(JSON.stringify(sent)).not.toContain("PRIVATE257")
    expect(JSON.stringify(sent)).not.toContain("/c/channels/s1/c1")
  } finally {
    view.unmount()
    await owner.registry.cleanup()
    owner.client.clear()
  }
})
